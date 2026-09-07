// The ten scenarios, in front of a real Claude Code, against the final package.
//
//   node scripts/eval/blockers/final.js --app=release/mac-universal/Stacki.app --out=<dir>
//   node scripts/eval/blockers/final.js --only=read-project,publish-once
//   node scripts/eval/blockers/final.js --selftest
//
// This is scripts/eval/blockers/native.js's shape — the packaged app, a
// recording proxy the server cannot see, a fresh contained Claude Code per
// scenario with no filesystem, shell or browser tools — pointed at the ten
// things §10 says have to hold when a stranger's agent drives the shipped
// bundle.
//
// THE ORACLES ARE THE CONTROLLER'S, NEVER THE AGENT'S SENTENCES. Nothing here
// grades a model on its account of its own work. What counts is:
//
//   * bytes read off disk with `fs`, and hashes of them;
//   * `git rev-parse`, `git log --format=%P`, `git show :2:` / `:3:` / `HEAD:`,
//     `git status --porcelain` — run by this process, against a repository this
//     process built;
//   * the fake `gh`'s own invocation log;
//   * the recorder's counts, refusal codes and response sizes;
//   * and, where a refusal has to be seen whole, THIS PROCESS'S OWN MCP CLIENT
//     to the packaged app, which sees the entire envelope rather than the
//     recorder's summary of it.
//
// That last channel is why several scenarios run a control of their own beside
// the agent. An elicitation — "did the model happen to send a mistyped
// argument this time" — is a measurement of the model. The control is a
// measurement of Stacki, it is evaluable on every run, and it is the one that
// can be red for a reason worth reading.
//
// THE MODEL'S PROSE IS RECORDED AS COLOUR, in `host.text`, and no check reads
// it.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const corpus = require(path.join(REPO, 'scripts/eval/heldout/corpus.js'));
const { createRecorder } = require(path.join(REPO, 'scripts/eval/heldout/recorder.js'));
const { runHost, claudeVersion, CREDENTIAL_VARS } = require(path.join(REPO, 'scripts/eval/heldout/host.js'));
const { startPackagedApp, available, APP } = require(path.join(REPO, 'test/support/packagedApp.js'));
const fixtures = require(path.join(REPO, 'scripts/eval/gitFixtures.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (h) => (h ? String(h).slice(0, 12) : null);
const same = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

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
  for (let port = from; port < from + 400; port += 1) {
    if (!(await portTaken(port))) return port;
  }
  throw new Error('no free port');
}

// ---------------------------------------------------------------------------
// what the controller watches while the agent works
// ---------------------------------------------------------------------------

/**
 * Every distinct state a file passes through, sampled from outside.
 *
 * Scenario 2 is "edit, undo, redo", and the middle two of those are gone by the
 * time the run ends: a file read only at the end cannot tell an edit that was
 * undone and redone from an edit that was made once. Neither can the model's
 * description of what it did, which is exactly the evidence this harness does
 * not accept. So the controller samples the bytes itself and reports the
 * TRAJECTORY, and the checks are about the shape of that.
 *
 * The sample interval is far shorter than a model turn: each of the three steps
 * is its own tool call with a round trip to the API in between, so a state that
 * existed for less than one sample did not exist for a caller either.
 */
function watchFile(abs, everyMs = 150) {
  const seen = [];
  let last = null;
  const tick = () => {
    let now;
    try {
      now = sha(fs.readFileSync(abs));
    } catch {
      now = 'ABSENT';
    }
    if (now !== last) {
      seen.push({ sha: now, at: Date.now() });
      last = now;
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return {
    states: () => seen.slice(),
    stop: () => {
      clearInterval(timer);
      tick();
      return seen.slice();
    },
  };
}

const wireRows = (file) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Do something the moment the wire shows the agent has done something else.
 *
 * Scenario 4 needs a ref to go stale BETWEEN the agent's read and the agent's
 * write, and "between" is not a thing a fixed sleep can express: too early and
 * the read has not happened, too late and the write already landed. The wire
 * says when the read came back, so the invalidation is triggered off that.
 */
function whenWireShows(wirePath, matches, act, everyMs = 120) {
  let done = false;
  let count = 0;
  let error = null;
  const timer = setInterval(() => {
    if (done) return;
    for (const row of wireRows(wirePath)) {
      if (!matches(row)) continue;
      done = true;
      clearInterval(timer);
      try {
        act(row);
        // COUNTED AFTER `act` RETURNS, NEVER BEFORE IT.
        //
        // The first version counted on the match and swallowed whatever `act`
        // threw, so `fired()` reported "the trigger matched" while the scenario
        // read it as "the invalidation happened". A `writeFileSync` that failed
        // — the whole point of the trigger — left the scenario green. Now the
        // count is the act's, and the throw is recorded for the scenario to turn
        // into a red check rather than being discarded here.
        count += 1;
      } catch (err) {
        error = String(err?.stack || err?.message || err).slice(0, 500);
      }
      return;
    }
  }, everyMs);
  return { fired: () => count > 0, matched: () => done, error: () => error, stop: () => clearInterval(timer) };
}

/**
 * Wait until a file has stopped growing, then say whether it settled.
 *
 * `recorder.stop()` resolves when the HTTP server closes. The JSONL log is a
 * separate write stream whose `end()` flushes asynchronously and is not awaited,
 * so the last rows of a session could still be in flight when a scenario read
 * the log. Every count-based check got redder from that — except "and got no
 * protocol error", which got GREENER, because a row that never landed is a row
 * that never carried an error.
 *
 * recorder.js is not this file's to change, so the wait lives here: the log is
 * watched until its size has been unchanged for `quietMs`, and whether that ever
 * happened is recorded rather than assumed. A run that times out here says so on
 * `flushed`, and the common checks turn that into a red.
 */
async function settleFile(file, { quietMs = 750, timeoutMs = 20000 } = {}) {
  // A "SIZE" THAT MEANS "NOT THERE" IS NOT A SIZE, AND IT IS NEVER STABLE.
  //
  // `sizeOf()` answered a constant -1 for a path that does not exist, and a
  // constant does not change: the loop saw -1 twice in a row, concluded the
  // file had stopped growing, and returned `{settled:true, bytes:-1}` for a log
  // it had never laid eyes on. "The recorder's log was flushed before it was
  // read" was therefore GREEN for a log that was never written — the same dead
  // shape as the checks this file has spent five rounds removing, hiding one
  // level down in a helper.
  //
  // A missing file is now never stable. The loop keeps waiting for it to appear
  // — it legitimately can, since the recorder's stream is created and flushed
  // asynchronously — and if it never does, the deadline returns `settled:false`
  // with `missing:true`, which the common checks turn into two separate reds.
  const MISSING = -1;
  const sizeOf = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return MISSING;
    }
  };
  const began = Date.now();
  const deadline = began + timeoutMs;
  let last = sizeOf();
  let stableSince = Date.now();
  for (;;) {
    await sleep(100);
    const now = sizeOf();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (now !== MISSING && Date.now() - stableSince >= quietMs) {
      return { settled: true, missing: false, bytes: now, waitedMs: Date.now() - began };
    }
    if (Date.now() > deadline) {
      return { settled: false, missing: now === MISSING, bytes: now, waitedMs: Date.now() - began };
    }
  }
}

// ---------------------------------------------------------------------------
// the pages and files the scenarios are about
// ---------------------------------------------------------------------------

const PRICING = 'src/pages/pricing.astro';
const NOTES = 'src/lib/notes.ts';
const DENSE = 'src/pages/dense.astro';

const LAYOUT = `---
const { title } = Astro.props;
---
<html lang="en">
  <head><title>{title}</title></head>
  <body><slot /></body>
</html>
`;

const CARD_COMPONENT = `---
const { title, price } = Astro.props;
---
<article class="card">
  <h3>{title}</h3>
  <p>{price}</p>
</article>
`;

// Comments sitting directly above the imports they annotate, four-space
// indentation and single-quoted attributes: the three things a whole-file
// re-serialization destroys, so an edit that survives them is an edit that went
// through the parser rather than around it.
const PRICING_PAGE = `---
// Layout import - the shell every page shares
import Layout from '../layouts/Layout.astro';

// Component imports
import Card from '../components/Card.astro';

// Page copy, kept together so it is easy to find
const heading = 'Pricing';
---

<Layout title={heading}>
    <section class='pricing'>
        <h1 class='pricing-title'>{heading}</h1>
        <Card
            title='Starter'
            price='9'
        />
        <!-- The comparison table is deliberately last -->
        <table class='comparison'>
            <tr><th>Plan</th><th>Price</th></tr>
        </table>
    </section>
</Layout>
`;

// A plain module the canvas never opens, so a write to it is compared against
// the bytes on disk. Scenario 4 is about that comparison.
const NOTES_MODULE = `// The notes the sidebar lists. Kept in one place on purpose.
export const notes = [
    { slug: 'first', title: 'The first note' },
    { slug: 'second', title: 'The second note' },
];
`;

// Dense enough that an audit of it takes long enough to be worth cancelling,
// which scenario 9 checks before it relies on it.
const densePage = () => {
  const rows = [];
  for (let i = 0; i < 140; i += 1) {
    rows.push(
      `  <section class="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 rounded-2xl border border-slate-200 p-6" id="row-${i}">\n` +
        `    <img src="/pic-${i}.png">\n` +
        `    <p style="color:#b8c0cc;background:#f4f6f9">Row ${i} of the pricing comparison, with a note that runs on for a while so the text has length.</p>\n` +
        `    <a href="#row-${i}"></a>\n` +
        `  </section>`
    );
  }
  return `---\nconst title = 'Dense';\n---\n<html>\n  <head><title>{title}</title></head>\n  <body>\n${rows.join('\n')}\n  </body>\n</html>\n`;
};

const put = (root, rel, text) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text, 'utf8');
};

/** A disposable copy of the held-out project, with the scenario's own pages in it. */
async function makeProject(dir, { pages = [], log }) {
  const source = await corpus.project('astro-portfolio', { log });
  corpus.checkout(source.root, dir);
  put(dir, 'src/layouts/Layout.astro', LAYOUT);
  put(dir, 'src/components/Card.astro', CARD_COMPONENT);
  for (const [rel, text] of pages) put(dir, rel, text);
  return { contentHash: source.contentHash, root: dir };
}

/** Everything at the top of a project that git should track. Never `git add -A`. */
const TRACKABLE = (root) =>
  fs
    .readdirSync(root)
    .filter((name) => !['node_modules', '.astro', 'dist', '.git', '.stacki-automation', '.DS_Store'].includes(name));

// ---------------------------------------------------------------------------
// the rig: a packaged app, a recorder in front of it, and a way to take both down
// ---------------------------------------------------------------------------

/** The config the host is handed. The real token never enters the file. */
function writeSafeConfig(workspace, url) {
  const file = path.join(workspace, 'mcp-config.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      { mcpServers: { stacki: { type: 'http', url, headers: { Authorization: 'Bearer ${STACKI_MCP_TOKEN}' } } } },
      null,
      1
    ),
    'utf8'
  );
  return file;
}

/**
 * Start the app and the recorder, or refuse.
 *
 * CONTAINMENT IS ESTABLISHED HERE OR NOT AT ALL. `startPackagedApp({contained})`
 * builds the app's environment with the same `containedEnv` the agent host uses,
 * which fails closed: it throws unless the GitHub credentials are gone from the
 * child's environment, `GH_CONFIG_DIR` points at a directory this run owns, and
 * `command -v gh` UNDER THAT ENVIRONMENT resolves to the fake. The check below
 * is the second lock: `containment` is null exactly when the app was launched
 * with the developer's own environment, and there is no scenario here that may
 * continue in that state — `git.publish` runs inside this process, not inside
 * the agent's.
 */
async function openRig({ ws, projectDir, appPath, access = 'edit', needPreview = false, log, out = null }) {
  const port = await freePort(45400 + ((process.pid % 40) * 8));
  const app = await startPackagedApp({ access, project: projectDir, app: appPath, portFrom: port, contained: true });
  const owned = { app, recorder: null };
  const readiness = { openOk: null, projectOpen: null, openCode: null, previewAsked: needPreview, previewStatus: null };
  let recorderEpoch = null;
  try {
    // RECORDED THE MOMENT THE APP EXISTS, so a rig that refuses below still
    // leaves the containment block and the shadow probe on the results file.
    if (out) {
      out.appContainment = app.containment;
      out.appGhProbe = probeShadow(app.containment?.ghResolvesTo || null);
      out.readiness = readiness;
    }
    if (!app.containment) throw new Error('refusing to continue: the packaged app was not launched contained');
    if (!app.containment.ghResolvesTo) throw new Error('refusing to continue: the app has no proven gh shadow');
    if ((app.containment.credentialsPresentAfter || []).length) {
      throw new Error(`refusing to continue: ${app.containment.credentialsPresentAfter.join(', ')} survived in the app`);
    }

    // BOTH OF THESE FAIL OPEN, SO BOTH ARE RAISED ON HERE.
    //
    // packagedApp.js:288 returns its last `project.info` when the deadline
    // passes, and :352 returns its last `capture` the same way — a timeout
    // arrives as an ORDINARY ANSWER, not as a throw. Throwing the results away
    // therefore let a run against an app that never opened the project, or never
    // rendered the preview, proceed to have its scenarios graded: every "the
    // agent asked Stacki for something" would be about an app with nothing open.
    const opened = await app.untilOpen();
    readiness.openOk = opened?.ok ?? null;
    readiness.openCode = opened?.code ?? null;
    readiness.projectOpen = opened?.project?.open ?? null;
    if (opened?.ok !== true || opened?.project?.open !== true) {
      throw new Error(`refusing to continue: the app never opened the project (ok=${JSON.stringify(readiness.openOk)} code=${JSON.stringify(readiness.openCode)} open=${JSON.stringify(readiness.projectOpen)})`);
    }
    if (needPreview) {
      const preview = await app.untilPreviewReady();
      readiness.previewStatus = preview?.status ?? null;
      if (!readiness.previewStatus || readiness.previewStatus === 'preview_not_ready' || readiness.previewStatus === 'preview_starting') {
        throw new Error(`refusing to continue: the preview never became ready (status=${JSON.stringify(readiness.previewStatus)})`);
      }
    }

    const wirePath = path.join(ws, 'wire.jsonl');
    const proxyPort = await freePort(48400 + ((process.pid % 40) * 8));
    // Taken immediately before the recorder is built, because its rows are
    // stamped relative to its own construction and scenario 2 has to place them
    // against wall-clock samples taken out here.
    recorderEpoch = Date.now();
    const recorder = createRecorder({ upstreamUrl: app.url, token: app.token, port: proxyPort, logPath: wirePath });
    await recorder.start();
    owned.recorder = recorder;
  } catch (err) {
    // THE RESIDUE OF A RIG THAT REFUSED IS PART OF THE RESULT.
    //
    // This was `try { await app.stop(); } catch {}`, which threw away the very
    // answer it had just asked for. `app.stop()` returns `{problems, ...}` —
    // a stranded preview server on its own port, a helper process that outlived
    // SIGKILL, a userData or project directory that would not go, the app's own
    // gh log — and a rig that refuses part way through is exactly the moment
    // those are most likely to exist. Discarding them meant `out.cleanup` said
    // only "the rig never opened" while a leaked process sat on the machine
    // unmentioned. The scenario is red either way; a leaked process is the one
    // thing this mission must be able to SEE, so it reaches the results file.
    let stopped = null;
    const problems = [];
    try {
      stopped = await app.stop();
      if (stopped?.problems?.length) problems.push(...stopped.problems);
    } catch (e) {
      problems.push(`app: ${e?.message || e}`);
    }
    if (out) {
      out.rigFailure = { why: String(err?.message || err).slice(0, 500), problems, stopped: stopped ? { pid: stopped.pid, port: stopped.port } : null };
      // The app's gh log would otherwise only reach `out` from a rig that
      // opened, so a refusal after `git.publish` had already run would lose it.
      if (stopped && Object.prototype.hasOwnProperty.call(stopped, 'ghCallsDuringTrial')) {
        out.appGhCalls = stopped.ghCallsDuringTrial ?? null;
      }
    }
    throw err;
  }

  let recorderStopped = false;
  const rig = {
    app,
    recorder: owned.recorder,
    readiness,
    recorderEpoch,
    wirePath: path.join(ws, 'wire.jsonl'),
    // What `settleFile` said about the log after the recorder was told to stop.
    // Null until it has been stopped, which is itself a red in the common checks.
    flush: null,
    stopRecorder: async () => {
      if (recorderStopped) return rig.flush;
      recorderStopped = true;
      await owned.recorder.stop();
      rig.flush = await settleFile(rig.wirePath);
      return rig.flush;
    },
    /** Run one Claude Code against the recorder. Contained, and it says so. */
    host: (brief, { model, effort, timeoutMs, tag }) => {
      fs.writeFileSync(path.join(ws, `BRIEF${tag ? `-${tag}` : ''}.md`), brief, 'utf8');
      const config = writeSafeConfig(ws, owned.recorder.url);
      return runHost({
        workspace: ws,
        url: owned.recorder.url,
        token: app.token,
        configPath: config,
        env: { STACKI_MCP_TOKEN: app.token },
        prompt: brief,
        mode: 'mcp-only',
        model,
        effort,
        timeoutMs,
        // TRUE, AND EARNED: the app above was launched through `containedEnv`
        // too, so the residual list this run records does not carry the entry
        // about an uncontained sibling.
        siblingsContained: true,
        log: (m) => log(m),
      });
    },
    /**
     * IS THE APP STILL THERE? Asked at the end of every scenario, of the app.
     *
     * Nine of the ten scenarios had no end-of-run liveness oracle at all, and
     * the wire cannot supply one: a packaged app that DIES mid-scenario is
     * invisible to `readWire`. recorder.js:155 records a transport failure as
     * `{method:'TRANSPORT_ERROR', error}` — a row with no `protocolError` key
     * and a `method` that is not `tools/call` — and answers the client with a
     * 502 carrying no JSON-RPC error object. So `protocolErrors` stays 0, no
     * `tools/call` row is added, and the call count simply stops growing. An
     * app that crashed reads exactly like an agent that decided it had enough.
     *
     * The fix is two-sided: those rows are now counted and asserted (see
     * `readWire`), and this asks the app itself, through the controller's own
     * MCP client rather than through the recorder, for something trivial after
     * the host has returned. A short timeout, because the answer to "is it
     * alive" must not be "we waited four minutes to find out".
     */
    probeLiveness: async () => {
      const began = Date.now();
      try {
        const envelope = await app.client.callTool({ name: 'project', arguments: { action: 'info' } }, { timeout: 30000 });
        const e = envelope?.structuredContent ?? null;
        return { asked: true, answered: true, ok: e?.ok === true, code: e?.code ?? null, open: e?.project?.open ?? null, error: null, ms: Date.now() - began };
      } catch (err) {
        return { asked: true, answered: false, ok: false, code: null, open: null, error: String(err?.message || err).slice(0, 300), ms: Date.now() - began };
      }
    },
    close: async () => {
      const problems = [];
      try {
        if (!recorderStopped) {
          recorderStopped = true;
          await owned.recorder.stop();
          rig.flush = await settleFile(rig.wirePath);
        }
      } catch (e) {
        problems.push(`recorder: ${e?.message || e}`);
      }
      let stopped = null;
      try {
        stopped = await app.stop();
        if (stopped?.problems?.length) problems.push(...stopped.problems);
      } catch (e) {
        problems.push(`app: ${e?.message || e}`);
      }
      return { problems, stopped };
    },
  };
  return rig;
}

/** What the recorder saw, reduced to the things a check may look at. */
function readWire(wirePath, flush = null) {
  const rows = wireRows(wirePath);
  const calls = rows.filter((r) => r.method === 'tools/call');
  const transportErrors = rows.filter((r) => r.method === 'TRANSPORT_ERROR');
  let bytes = -1;
  try {
    bytes = fs.statSync(wirePath).size;
  } catch {
    bytes = -1;
  }
  return {
    rows,
    // WHETHER THE LOG WAS WHOLE WHEN IT WAS READ, carried beside the counts
    // taken from it rather than assumed. `flushed !== true` means some of the
    // rows below may never have reached disk, and every count here is a floor.
    flushed: flush ? flush.settled === true : null,
    flushWaitedMs: flush?.waitedMs ?? null,
    bytes,
    missing: bytes < 0,
    empty: rows.length === 0,
    calls: calls.length,
    byTool: calls.reduce((acc, r) => {
      acc[r.name || '?'] = (acc[r.name || '?'] || 0) + 1;
      return acc;
    }, {}),
    auditCalls: calls.filter((r) => r.name === 'audit').length,
    refusals: calls.filter((r) => r.envelopeNotOk).map((r) => ({ name: r.name, code: r.refusalCode, args: String(r.args || '').slice(0, 200) })),
    refusalCodes: [...new Set(calls.filter((r) => r.envelopeNotOk).map((r) => r.refusalCode).filter(Boolean))],
    protocolErrors: rows.filter((r) => r.protocolError).length,
    // A DEAD UPSTREAM, MADE VISIBLE.
    //
    // recorder.js:155 records the proxy's own relay failure as
    // `{method:'TRANSPORT_ERROR', error}`. That row is not a `tools/call`, so
    // it is not in `calls`; it has no `protocolError` key, so `protocolErrors`
    // stays 0; and the client gets a bare 502 with no JSON-RPC error in it, so
    // nothing downstream records one either. Every count above was therefore
    // silent about the one failure that invalidates all of them — the app going
    // away mid-scenario looked precisely like an agent that stopped asking.
    // These two are that row, counted and quoted, and `commonChecks` asserts
    // the count is zero.
    transportErrors: transportErrors.length,
    transportErrorMessages: [...new Set(transportErrors.map((r) => String(r.error || '').slice(0, 200)))],
    maxResponseBytes: calls.reduce((n, r) => Math.max(n, r.responseBytes || 0), 0),
  };
}

/** The host's answer, trimmed to what a report should carry. */
const hostSummary = (h) => ({
  ok: h.ok,
  error: h.error || null,
  exitCode: h.exitCode ?? null,
  timedOut: h.timedOut ?? null,
  elapsedMs: h.elapsedMs ?? null,
  turns: h.turns ?? null,
  builtinToolCalls: h.builtinToolCalls,
  builtinUsed: h.builtinUsed,
  mcpToolCalls: h.mcpToolCalls,
  toolUse: h.toolUse,
  containment: h.containment,
  // COLOUR ONLY. No check in this file reads it.
  text: typeof h.text === 'string' ? h.text.slice(0, 4000) : null,
});

/**
 * The shadow, MEASURED, while the process it belongs to is still running.
 *
 * `containedEnv`'s `assertions.ghResolvesTo` is the string `fake.bin`, assigned
 * by the same function that built it — a check comparing it against the shape of
 * a fake path was comparing a constant against a constant, and could not be red.
 * This asks the filesystem and the shell instead:
 *
 *   * is there a program at that path at all, and is it executable;
 *   * is it the fake — recognised by the fact that it appends to the very
 *     `invocations.log` whose emptiness the isolation check reads, which is what
 *     ties "the log was empty" to "this is the program that would have written
 *     it";
 *   * and does `command -v gh`, with that directory in front of PATH, resolve to
 *     exactly it.
 *
 * The last one is the one that goes red for the failure that matters: a fake
 * that is missing, or not executable, is a fake `command -v` walks straight past
 * on its way to the real `gh`.
 *
 * READ, NEVER RUN. Executing the fake would put a row in the invocation log that
 * the isolation checks require to be empty.
 */
function probeShadow(binPath) {
  const seen = { probedAt: binPath || null, exists: false, executable: false, isFake: false, lookupResolvedTo: null, error: null };
  if (!binPath) return seen;
  try {
    const dir = path.dirname(binPath);
    seen.exists = fs.existsSync(binPath);
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      seen.executable = true;
    } catch {
      seen.executable = false;
    }
    if (seen.exists) {
      const text = fs.readFileSync(binPath, 'utf8');
      seen.isFake = text.startsWith('#!/bin/sh') && text.includes('fake gh') && text.includes(path.join(dir, 'invocations.log'));
    }
    seen.lookupResolvedTo =
      execFileSync('/bin/sh', ['-c', 'command -v gh'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH || ''}` },
      }).trim() || null;
  } catch (err) {
    seen.error = String(err?.message || err).slice(0, 300);
  }
  return seen;
}

/** Where the real `gh` is, so a scenario can assert it was never the one used. */
function realGhPath() {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the checks every scenario carries
// ---------------------------------------------------------------------------

// The fake `gh` is written into a directory this run made, and only into one.
// Matching the SHAPE of that directory keeps the check live on a machine where
// `gh` is not installed at all: comparing against the real one is worth doing
// and is vacuous when there is no real one to compare against.
const FAKE_GH = /\/stacki-fake-gh-[^/]+\/gh$/;

/**
 * What must be true of any run in this file, whatever it was about.
 *
 * FIVE OF THESE COULD NOT BE RED, and are gone.
 *
 * `containedEnv` throws at host.js:223-224 if any credential survived its strip,
 * so `assertions.credentialsPresentAfter` is `[]` on every result that exists at
 * all: "every GitHub credential was stripped" was reading a constant. The same
 * function assigns `assertions.ghResolvesTo = fake.bin`, so matching it against
 * the shape of a path this run made was comparing the builder's own output to
 * the builder's own naming convention. Neither was a measurement, and a check
 * that cannot go red is worse than no check because the report counts it.
 *
 * What replaces them is the same question asked of the world:
 *
 *   * the fields are PRESENT and typed before their values are read, so a
 *     containment block that stopped being produced is red rather than green by
 *     way of `undefined`;
 *   * the app's shadow is probed while the app is alive — the program is on
 *     disk, is executable, is the fake that writes the log the isolation check
 *     reads, and `command -v gh` in front of it lands on exactly that program;
 *   * the two shadows are asserted to be two DIFFERENT directories, because
 *     `publish-once` reads one log for "gh created a repository exactly once"
 *     and the other for "the agent's gh was never invoked", and one shared fake
 *     would silently merge them;
 *   * the APP's shadow is asserted gone after teardown — reachable, because
 *     packagedApp.js records a containment that would not tear down as a
 *     problem instead of dying. (The AGENT's was asserted gone too and could
 *     not be red: host.js tears it down unguarded inside its 'exit' handler and
 *     fakeGh's cleanup throws unless the directory is already removed, so the
 *     run could not return at all with that directory still on disk.)
 *   * the instrument itself is asked whether it lost the app: a relay failure
 *     is recorded by the recorder in a shape — `method:'TRANSPORT_ERROR'`, no
 *     `protocolError`, a bare 502 to the client — that every count in this file
 *     was blind to, and a dead app read as an agent that stopped asking.
 *   * and the app is asked, by this process's own MCP client, whether it is
 *     still there at all.
 *
 * `credentialsPresentAfter` is still written into the results file as colour.
 * It is not asserted, because the only thing that could make it non-empty is a
 * throw that would have prevented the run.
 */
function commonChecks(need, out) {
  const host = out.host || {};
  const c = host.containment || null;
  const app = out.appContainment || null;
  const probe = out.appGhProbe || null;
  // `typeof … === 'number'`, NOT `!== null`. `out.host` is absent for a scenario
  // that threw before the host ran, and `undefined !== null` is true — so the
  // first version of this check reported "the host actually started" as green
  // for a run in which no host was ever spawned. A missing result is not a pass.
  need('the host actually started', !!out.host && host.error == null && typeof host.exitCode === 'number');
  // AND FINISHED ON ITS OWN TERMS. `exitCode` being a number says a process ran
  // and stopped; it says nothing about whether it stopped because it was done. A
  // claude that exited 1 having made no tool call, or one the harness had to
  // SIGTERM at the deadline, was recorded as a started host and its scenario was
  // graded on whatever partial wire it left.
  need('and finished on its own terms rather than being killed at the deadline', host.ok === true && host.timedOut === false);
  need('no built-in tool call — the agent had only Stacki', host.builtinToolCalls === 0);

  // --- presence, then value ---------------------------------------------------
  need('the agent recorded a containment block', !!c && typeof c === 'object');
  need('naming the gh it would have resolved', typeof c?.ghResolvesTo === 'string' && c.ghResolvesTo.length > 0);
  need('and that name is a fake this run made', FAKE_GH.test(String(c?.ghResolvesTo || '')));
  need('the app recorded a containment block', !!app && typeof app === 'object');
  need('naming the gh the app would have resolved', typeof app?.ghResolvesTo === 'string' && app.ghResolvesTo.length > 0);
  need('and that name is a fake this run made too', FAKE_GH.test(String(app?.ghResolvesTo || '')));
  // Extra rather than instead: vacuous on a machine with no gh installed, which
  // is why the two checks above are shaped the way they are.
  need('and neither was the real gh', out.realGh == null || (c?.ghResolvesTo !== out.realGh && app?.ghResolvesTo !== out.realGh));

  // --- and the same claim, measured -------------------------------------------
  need("the app's gh shadow was probed while the app was running", !!probe && probe.error == null && probe.probedAt === (app?.ghResolvesTo ?? null) && probe.probedAt != null);
  need('there was a program at that path, and it was executable', probe?.exists === true && probe?.executable === true);
  need('it was the fake — the one that writes the log this run reads', probe?.isFake === true);
  need('and `command -v gh` in front of it resolved to exactly that program', probe?.lookupResolvedTo != null && probe.lookupResolvedTo === app?.ghResolvesTo);
  // WAS "the agent's own fake gh went with it", AND THAT COULD NOT BE RED.
  //
  // `runHost` tears the agent's containment down inside its 'exit' handler with
  // an unguarded `contained.cleanup()` (host.js:595), and `fake.cleanup()`
  // (test/support/fakeGh.js:129-133) removes the directory and THROWS if it is
  // still there afterwards. A throw out of an 'exit' handler takes the process
  // with it, so no result ever reaches this function unless the directory is
  // already gone: `!fs.existsSync(c.ghResolvesTo)` was a precondition of the run
  // having finished at all, dressed as a measurement. Deleted, and replaced by
  // the two facts about the shadows that a run CAN get wrong.
  //
  // First: the two shadows are two directories. The whole of `publish-once`
  // rests on the app's gh log and the agent's gh log being separate instruments
  // — "gh created a repository exactly once" is read off the app's, "the agent's
  // gh was never invoked" off the agent's. One shared fake would merge them and
  // make both readings mean something else. Red the moment the two containments
  // stop being built independently.
  need("the agent's shadow and the app's are two different fakes", typeof c?.ghResolvesTo === 'string' && typeof app?.ghResolvesTo === 'string' && c.ghResolvesTo !== app.ghResolvesTo);
  // Second: the APP's fake went with the app. This one is reachable where the
  // agent's was not — packagedApp.js:394-399 wraps `containment.cleanup()` in a
  // try/catch and records the failure as a cleanup problem rather than dying, so
  // a fake `gh` that would not be removed arrives here as a live result with the
  // directory still on disk.
  need("and the app's fake gh went with the app", typeof app?.ghResolvesTo === 'string' && app.ghResolvesTo.length > 0 && !fs.existsSync(app.ghResolvesTo));

  need('the agent had its own GH_CONFIG_DIR', !!c && typeof c.ghConfigDir === 'string' && c.ghConfigDir.startsWith(os.tmpdir()));
  // TRUE OF EVERY SCENARIO INCLUDING THE PUBLISH ONE. `git.publish` runs inside
  // the packaged app, so the app's gh log is where that one invocation lands;
  // the AGENT's own gh is never the right route to GitHub in any of the ten, and
  // an invocation in its log would be the agent going around Stacki.
  need("the agent's gh was never invoked", Array.isArray(c?.ghCallsDuringTrial) && c.ghCallsDuringTrial.length === 0);

  // --- the instrument, before anything is counted off it ----------------------
  // Every count below is a floor if the log was still flushing when it was read,
  // and "no protocol error" is the one check that gets GREENER from a lost row.
  // THE LOG EXISTED AT ALL. `readWire` has recorded `missing` since it was
  // written and nothing read it; with `settleFile` no longer calling a file it
  // never saw "settled", this and the next check are two distinct reds rather
  // than one accidental green.
  need('the recorder wrote a log', out.wire?.missing === false && out.wire?.bytes > 0);
  need("the recorder's log was flushed before it was read", out.wire?.flushed === true);
  // NO `|| 0` DEFAULT. `calls >= (host.mcpToolCalls || 0)` degrades to
  // `calls >= 0` when the count is missing — vacuous, and missing is exactly the
  // case where the two instruments most need comparing. Both numbers must be
  // numbers before either is read.
  need("and the recorder saw every MCP call the host's own transcript counted", typeof out.wire?.calls === 'number' && typeof host.mcpToolCalls === 'number' && out.wire.calls >= host.mcpToolCalls);
  // AND THE UPSTREAM NEVER WENT AWAY UNDER IT. A relay failure is the one event
  // that makes every count above a fiction rather than a floor, and it is
  // recorded in a shape no other check in this file could see.
  need('and never lost the app mid-run — no transport error on the wire', out.wire?.transportErrors === 0);

  // --- and the app was still alive at the end ---------------------------------
  //
  // Asked of the app by the controller's own MCP client after the host returned.
  // Without it, a packaged app that crashed part way through a scenario is
  // indistinguishable from an agent that stopped asking: the wire's `calls`
  // count simply stops growing, and every other oracle here reads the final
  // state of a repository or a file, which a crash leaves perfectly readable.
  need('the app was still answering when the scenario ended', out.liveness?.answered === true && out.liveness?.ok === true);

  need('no cleanup problem', Array.isArray(out.cleanup) && out.cleanup.length === 0);
}

// ---------------------------------------------------------------------------
// the ten
// ---------------------------------------------------------------------------
//
// The briefs are what a person would type. None names a tool, an operation, a
// ref or an expected refusal code — except scenario 3, where the point IS that
// the person is repeating a spelling out of stale notes, which is how a real
// mistyped argument arrives.

const SCENARIOS = {
  // 1 -----------------------------------------------------------------------
  'read-project': {
    summary: 'the agent reads the project and reports its structure',
    timeoutMs: 600000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE]], log });
      const before = corpus.contentHash(projectDir);
      out.projectBefore = before;

      const rig = await openRig({ ws, projectDir, appPath, access: 'inspect', log, out });
      ctx.rig = rig;

      // --- the control, because nothing else here asks whether Stacki ANSWERED -
      //
      // `wire.calls` counts every `tools/call` row whatever came back, and a
      // refusal is a successful round trip: the recorder records `envelopeNotOk`
      // for it, not `protocolError`. So ">= 3 calls, no protocol error, nothing
      // on disk moved" was green for a Stacki that answered `{ok:false}` to
      // every single operation — the most complete failure this scenario is
      // about, graded as a pass. These two calls are the controller's own, they
      // go straight to the app rather than through the recorder, and they are
      // evaluable on every run.
      const info = await rig.app.call('project', { action: 'info' });
      const read = await rig.app.call('source', { action: 'read', path: PRICING });
      out.control = {
        info: { ok: info?.ok ?? null, code: info?.code ?? null, open: info?.project?.open ?? null },
        read: {
          ok: read?.ok ?? null,
          code: read?.code ?? null,
          bytes: typeof read?.text === 'string' ? Buffer.byteLength(read.text, 'utf8') : null,
          // Not merely non-empty: the bytes that came back are the bytes this
          // harness wrote, so an answer assembled from somewhere else is red.
          isTheFileOnDisk: typeof read?.text === 'string' && read.text.includes("<h1 class='pricing-title'>{heading}</h1>"),
        },
      };

      const host = await rig.host(
        'Have a look at this project and tell me what it is made of — how many pages it has, what components ' +
          'they use, and where its styles live. Do not change anything.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);
      out.answeredCalls = (out.wire.rows || []).filter((r) => r.method === 'tools/call' && !r.envelopeNotOk && !r.protocolError && !r.toolError).length;
      const after = corpus.contentHash(projectDir);
      out.projectAfter = after;
      out.projectUnchanged = after.hash === before.hash;
    },
    check(need, out) {
      need('CONTROL: the app says the project is open', out.control?.info?.ok === true && out.control?.info?.open === true);
      need('CONTROL: a source read came back ok', out.control?.read?.ok === true);
      need('CONTROL: with the bytes this harness put on disk in it', out.control?.read?.isTheFileOnDisk === true && out.control?.read?.bytes > 0);
      need('the agent asked Stacki for something', (out.wire?.calls || 0) >= 3);
      // AND WAS ANSWERED. A refused call is a call, so the count above is about
      // the agent and this one is about Stacki.
      need('and at least three of those calls came back ok', (out.answeredCalls || 0) >= 3);
      need('and got no protocol error', out.wire?.protocolErrors === 0);
      // The content hash is over every path and every byte, so a separate
      // file-count check could not be red while this one was green. Removed
      // rather than kept as decoration.
      need('not one byte of the project changed', out.projectUnchanged === true);
    },
  },

  // 2 -----------------------------------------------------------------------
  'edit-undo-redo': {
    summary: 'a structural edit, undone, and redone — measured as a trajectory on disk',
    timeoutMs: 1200000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE]], log });
      const target = path.join(projectDir, PRICING);
      const before = fs.readFileSync(target);
      out.before = sha(before);

      const rig = await openRig({ ws, projectDir, appPath, needPreview: true, log, out });
      ctx.rig = rig;
      // Started only once the app is up, so the app's own project-open writes
      // are not read as the agent's first edit.
      const watch = watchFile(target);
      const host = await rig.host(
        'On the /pricing page, the pricing card shows 9 and it should show 12. Change it. ' +
          'Then undo that change. Then redo it, so the page ends up showing 12. ' +
          'Tell me what you did at each of the three steps.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await rig.stopRecorder();
      const states = watch.stop();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);
      out.trajectory = states.map((s) => ({ sha: short(s.sha), at: s.at - states[0].at }));

      const after = fs.readFileSync(target);
      out.after = sha(after);
      const line = states.map((s) => s.sha);
      // THE SHAPE THE THREE STEPS LEAVE BEHIND: something other than the
      // original, then the original again, then something other than it again.
      // Read off the sampled states, not off the model's account.
      // The sampler starts after the app is up, so its first reading must still
      // be the bytes this harness wrote. If it is not, something moved the file
      // before the agent did and every step index below is measured from the
      // wrong place.
      out.startedAtOriginal = line[0] === out.before;
      const firstEdit = line.findIndex((s, i) => i > 0 && s !== out.before);
      const backToStart = firstEdit === -1 ? -1 : line.findIndex((s, i) => i > firstEdit && s === out.before);
      const redone = backToStart === -1 ? -1 : line.findIndex((s, i) => i > backToStart && s !== out.before);
      out.steps = { firstEdit, backToStart, redone, distinctStates: new Set(line).size };
      out.undoWasByteExact = backToStart !== -1;
      out.endedEdited = out.after !== out.before;

      const text = after.toString('utf8');
      out.commentsIntact = /\/\/ Layout import - the shell every page shares\nimport Layout/.test(text) && /\/\/ Component imports\nimport Card/.test(text);
      out.quotesIntact = text.includes("class='pricing'") && text.includes("class='comparison'");
      out.indentIntact = text.includes("\n    <section class='pricing'>");

      // --- AND WHERE THOSE STATES CAME FROM -----------------------------------
      //
      // The trajectory alone is not evidence of an undo. THREE ORDINARY WRITES
      // produce exactly the same shape: write 12, write the original bytes back,
      // write 12 again. So the sampled states are placed against the wire, and
      // the wire is asked which operations Stacki was actually running when the
      // file moved. `project.undo` and `project.redo` are Stacki's own stack —
      // the one ⌘Z uses — and nothing else in this file's briefs would produce
      // them.
      //
      // The row stamps are relative to the recorder's construction, so they are
      // put back on the wall clock with the epoch the rig captured at that
      // moment. SLACK is generous in both directions on purpose: the sampler
      // ticks every 150ms and can see a write up to that late, and a row is
      // stamped when the RESPONSE finished, which is after the write it caused.
      const SLACK = 4000;
      const epoch = rig.recorderEpoch;
      const at = (row) => (typeof epoch === 'number' && typeof row.at === 'number' ? epoch + row.at : null);
      const projectCalls = (word) =>
        (out.wire.rows || [])
          .filter((r) => r.method === 'tools/call' && r.name === 'project' && new RegExp(`"action"\\s*:\\s*"${word}"`).test(String(r.args || '')))
          .map(at)
          .filter((t) => typeof t === 'number')
          .sort((a, b) => a - b);
      const undoAt = projectCalls('undo');
      const redoAt = projectCalls('redo');
      const stateAt = (i) => (i >= 0 && states[i] ? states[i].at : null);
      const firstEditAt = stateAt(out.steps.firstEdit);
      const backToStartAt = stateAt(out.steps.backToStart);
      const redoneAt = stateAt(out.steps.redone);
      const within = (times, from, to) => times.find((t) => t >= from - SLACK && t <= to + SLACK) ?? null;
      out.undoRedo = {
        recorderEpoch: epoch,
        undoCalls: undoAt.length,
        redoCalls: redoAt.length,
        firstEditAt,
        backToStartAt,
        redoneAt,
        // The undo that could have produced the return to the original bytes:
        // one issued after the edit landed and no later than the sample that saw
        // the original again.
        undoBehindTheReturn: firstEditAt != null && backToStartAt != null ? within(undoAt, firstEditAt, backToStartAt) : null,
        redoBehindTheFinal: backToStartAt != null && redoneAt != null ? within(redoAt, backToStartAt, redoneAt) : null,
      };
      out.undoRedo.inOrder =
        out.undoRedo.undoBehindTheReturn != null &&
        out.undoRedo.redoBehindTheFinal != null &&
        out.undoRedo.undoBehindTheReturn < out.undoRedo.redoBehindTheFinal;
    },
    check(need, out) {
      need('the sampler started on the bytes the harness wrote', out.startedAtOriginal === true);
      need('the file left its starting bytes', out.steps?.firstEdit > 0);
      need('and came back to them exactly — the undo is on disk', out.undoWasByteExact === true);
      need('and left them again — the redo is on disk', out.steps?.redone > 0);
      need('and the file does not end where it started', out.endedEdited === true);
      // THE TRAJECTORY IS NOT THE OPERATION. Three ordinary source writes draw
      // the identical line, so the wire is asked what Stacki was doing.
      need("Stacki's own undo stack was stepped, not rewritten over", (out.undoRedo?.undoCalls || 0) >= 1);
      need('and its redo too', (out.undoRedo?.redoCalls || 0) >= 1);
      need('an undo call is what stands behind the return to the original bytes', out.undoRedo?.undoBehindTheReturn != null);
      need('a redo call is what stands behind the final state', out.undoRedo?.redoBehindTheFinal != null);
      need('and they happened in that order', out.undoRedo?.inOrder === true);
      need('the frontmatter comments are still attached to their imports', out.commentsIntact === true);
      need('the quotes elsewhere are untouched', out.quotesIntact === true);
      need('the indentation is untouched', out.indentIntact === true);
    },
  },

  // 3 -----------------------------------------------------------------------
  'bad-argument': {
    summary: 'a mistyped argument is refused, and the well-formed one is not',
    timeoutMs: 600000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE]], log });
      const before = corpus.contentHash(projectDir);
      out.projectBeforeHash = before.hash;

      const rig = await openRig({ ws, projectDir, appPath, needPreview: true, log, out });
      ctx.rig = rig;

      // --- the control, which is evaluable on every run -----------------------
      // Two calls that differ by ONE key. If the first is refused and the second
      // is not, the refusal is about the argument; if both are refused, the tool
      // is simply broken and this scenario would otherwise have called that a
      // pass.
      const mistyped = await rig.app.call('audit', { route: '/pricing', viewport: 'phone', rules: [] });
      const wellFormed = await rig.app.call('audit', { route: '/pricing', viewports: ['phone'], rules: [] });
      // And the same question of a domain tool, whose arguments are a closed
      // union rather than a closed object.
      const mistypedDomain = await rig.app.call('source', { action: 'read', path: PRICING, startLIne: 1 });
      const wellFormedDomain = await rig.app.call('source', { action: 'read', path: PRICING });
      out.control = {
        mistyped: { ok: mistyped?.ok ?? null, code: mistyped?.code ?? null },
        wellFormed: { ok: wellFormed?.ok ?? null, code: wellFormed?.code ?? null },
        mistypedDomain: { ok: mistypedDomain?.ok ?? null, code: mistypedDomain?.code ?? null },
        wellFormedDomain: { ok: wellFormedDomain?.ok ?? null, code: wellFormedDomain?.code ?? null },
      };
      out.afterControl = corpus.contentHash(projectDir).hash;

      const host = await rig.host(
        'Run the accessibility check on the /pricing page. Our notes say the call takes `viewport: "phone"` and ' +
          '`wcagLevel: "AA"`, so use exactly that. If Stacki will not take it, tell me the exact words it came ' +
          'back with and what it wanted instead.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);
      out.badArgumentRefusals = (out.wire.refusals || []).filter((r) => r.code === 'bad_arguments').length;
      out.projectAfter = corpus.contentHash(projectDir).hash;
      out.projectUnchanged = out.projectAfter === before.hash;
    },
    check(need, out) {
      need('CONTROL: an unknown key on audit is refused', out.control?.mistyped?.ok === false);
      need('CONTROL: and the refusal is bad_arguments', out.control?.mistyped?.code === 'bad_arguments');
      need('CONTROL: the same call without that key is accepted', out.control?.wellFormed?.ok === true);
      need('CONTROL: an unknown key on a domain tool is refused too', out.control?.mistypedDomain?.ok === false);
      need('CONTROL: and that refusal is bad_arguments', out.control?.mistypedDomain?.code === 'bad_arguments');
      need('CONTROL: the same domain call without it is accepted', out.control?.wellFormedDomain?.ok === true);
      // ITS OWN CHECK, and no longer a disjunction with the whole-scenario one.
      // `A === B || C` was green whenever C was, so a control that HAD written
      // something could not have shown up here.
      need('CONTROL: neither refusal changed the project', out.afterControl === out.projectBeforeHash);
      need('the agent was refused for a bad argument at least once', out.badArgumentRefusals > 0);
      need('and nothing on disk changed across the whole scenario', out.projectUnchanged === true);
    },
  },

  // 4 -----------------------------------------------------------------------
  'stale-ref': {
    summary: 'a ref invalidated under the agent between read and write is refused',
    timeoutMs: 900000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE], [NOTES, NOTES_MODULE]], log });
      const target = path.join(projectDir, NOTES);

      const rig = await openRig({ ws, projectDir, appPath, log, out });
      ctx.rig = rig;

      // --- the control ---------------------------------------------------------
      // Read, invalidate underneath, then offer the write the read authorised.
      // The bytes on disk after the refusal are checked as well as the code: a
      // refusal that had already written would be worse than no refusal.
      const read = await rig.app.call('source', { action: 'read', path: NOTES });
      const ref = read?.ref || null;
      const invalidated = `${NOTES_MODULE}// invalidated by the controller ${crypto.randomUUID()}\n`;
      fs.writeFileSync(target, invalidated, 'utf8');
      const stale = await rig.app.call('source', { action: 'write', path: NOTES, text: '// the stale write\n', ref });
      const afterStale = fs.readFileSync(target, 'utf8');
      // And the positive half: a ref read from the CURRENT bytes is accepted, so
      // the refusal above is about staleness and not about guarded writes.
      const fresh = await rig.app.call('source', { action: 'read', path: NOTES });
      // NO `|| null` FALLBACK, AND THE REF IS ITS OWN CHECK.
      //
      // `ref: fresh?.ref || null` silently downgraded to an UNGUARDED write on
      // any run where the fresh read came back without a ref — and "an unguarded
      // write is accepted" is a different fact from "a fresh guard is honoured".
      // The scenario would have gone on measuring the first while reporting the
      // second. With no fresh ref the call is not made at all, and `hadFreshRef`
      // is what goes red.
      const freshRef = typeof fresh?.ref === 'string' && fresh.ref.length > 0 ? fresh.ref : null;
      const accepted = freshRef ? await rig.app.call('source', { action: 'write', path: NOTES, text: invalidated, ref: freshRef }) : null;
      out.control = {
        hadRef: typeof ref === 'string' && ref.length > 0,
        stale: { ok: stale?.ok ?? null, code: stale?.code ?? null },
        staleWroteNothing: afterStale === invalidated,
        hadFreshRef: freshRef != null,
        fresh: { ok: accepted?.ok ?? null, code: accepted?.code ?? null },
      };

      // --- and the agent, with the same trick played on it ----------------------
      const marker = `// CONTROLLER MOVED THIS FILE ${crypto.randomUUID()}\n`;
      const before = fs.readFileSync(target, 'utf8');
      const trip = whenWireShows(
        rig.wirePath,
        (r) => r.method === 'tools/call' && r.name === 'source' && String(r.args || '').includes('"read"') && String(r.args || '').includes('notes.ts'),
        () => fs.writeFileSync(target, `${before}${marker}`, 'utf8')
      );
      const host = await rig.host(
        `Read ${NOTES} and then rewrite it so the exported list has four notes in it instead of two, keeping the ` +
          'same shape for the two new ones. Tell me exactly what happened when you tried to save it.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      trip.stop();
      await rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);
      out.invalidationMatched = trip.matched();
      out.invalidationFired = trip.fired();
      out.invalidationError = trip.error();
      // GUARD_REQUIRED IS NOT A STALENESS COMPARISON, and counting it here made
      // the scenario green for an agent that simply forgot to send a ref — the
      // opposite of the property. It is recorded beside the count as colour so
      // the run is still readable, and it is not what the check reads.
      out.staleRefusals = (out.wire.refusals || []).filter((r) => ['stale_target', 'stale_ref'].includes(r.code)).length;
      out.guardRequiredRefusals = (out.wire.refusals || []).filter((r) => r.code === 'guard_required').length;

      // --- AND WHETHER THE MARKER SURVIVED ------------------------------------
      //
      // "Refused rather than clobbering it" was never measured: the agent half
      // read nothing back, so an agent that was refused once and then wrote over
      // the controller's bytes anyway passed. The marker is a whole trailing
      // comment line in a file the agent was asked to edit in one specific way
      // (two more entries in an exported array), so the correct loop — refused,
      // re-read the moved file, write what that read authorised — carries it
      // through. Its disappearance means the bytes that landed did not come from
      // the moved file, which is precisely the clobber.
      const finalText = fs.readFileSync(target, 'utf8');
      out.finalSha = sha(Buffer.from(finalText, 'utf8'));
      out.markerLine = marker.trim();
      out.markerSurvived = finalText.includes(marker.trim());
      out.finalBytes = Buffer.byteLength(finalText, 'utf8');
    },
    check(need, out) {
      need('CONTROL: the read handed back a ref', out.control?.hadRef === true);
      need('CONTROL: the write on the moved file was refused', out.control?.stale?.ok === false);
      need('CONTROL: and refused as stale rather than generically', ['stale_target', 'stale_ref'].includes(out.control?.stale?.code));
      need('CONTROL: and the refusal wrote nothing', out.control?.staleWroteNothing === true);
      need('CONTROL: the fresh read handed back a ref of its own', out.control?.hadFreshRef === true);
      need('CONTROL: and a write guarded by THAT ref is accepted', out.control?.fresh?.ok === true);
      need('the controller did invalidate under the agent', out.invalidationFired === true && out.invalidationError == null);
      need('and the agent was refused as stale at least once', out.staleRefusals > 0);
      need("and the controller's marker is still in the file — nothing wrote over the moved bytes", out.markerSurvived === true);
    },
  },

  // 5 -----------------------------------------------------------------------
  'conflict-builtin-theirs': {
    summary: "a standard git conflict, resolved hunk by hunk with the incoming side",
    timeoutMs: 1200000,
    git: 'builtin',
    async run(ctx) {
      const { out, model, effort } = ctx;
      const repo = ctx.repo;
      // A read-only look through Stacki's own eyes, before the agent. git.merge
      // unwinds what it tries, so this costs the fixture nothing — and it is the
      // only place the whole conflict envelope is visible.
      const seen = await ctx.rig.app.call('git', { action: 'merge', branch: repo.branch });
      const file = (seen?.files || []).find((f) => f.path === repo.path) || null;
      out.merge = {
        ok: seen?.ok ?? null,
        code: seen?.code ?? null,
        conflictCount: seen?.conflictCount ?? null,
        file: file && { path: file.path, customDriver: file.customDriver ?? null, hunkCount: Array.isArray(file.hunks) ? file.hunks.length : null, hunksNull: file.hunks === null },
      };
      out.afterLook = fixtures.observe(repo);

      const host = await ctx.rig.host(
        `This project has a branch called "${repo.branch}". Merge it into the branch we are on. ` +
          `There is one region of ${repo.path} the two branches disagree about — resolve that one region by ` +
          "taking the incoming branch's wording for it, and leave everything else exactly as the merge worked it out. " +
          'Then commit the merge.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await ctx.rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(ctx.rig.wirePath, ctx.rig.flush);
      out.after = fixtures.observe(repo);
    },
    check(need, out, ctx) {
      const repo = ctx.repo;
      const a = out.after || {};
      // WHAT THE CONFLICT IS MADE OF, not what did not happen to it.
      //
      // `driverRan === false` for this kind was a check with no reachable red:
      // gitFixtures.js writes no driver script at all for `builtin`, so there is
      // no program on disk that could have set the sentinel. What the scenario
      // actually depends on is that git's OWN diff3 markup is there — that is
      // what makes per-hunk answers meaningful and what `expectedPerHunkTheirs`
      // is computed from — and that nothing signed it. Both go red for a
      // developer config or a git version that produced two-marker markup or ran
      // something.
      need("git wrote its own diff3 markup — nobody's program produced this conflict", /^<{7} /m.test(repo.conflicted) && /^\|{7}/m.test(repo.conflicted) && /^={7}$/m.test(repo.conflicted));
      need('and nothing signed it as a driver’s output', !repo.conflicted.includes(fixtures.SENTINEL));
      // ASKED FIRST, because `out.merge.file` is null when Stacki did not report
      // the path at all — and `null?.customDriver == null` is true, so the next
      // check would have been green for a merge that never mentioned the file.
      need('Stacki reported the conflicting file', !!out.merge?.file);
      need('and said so too — no customDriver on it', !!out.merge?.file && out.merge.file.customDriver == null);
      need('and it offered exactly one hunk to answer', out.merge?.file?.hunkCount === 1);
      need('looking at the conflict changed nothing', out.afterLook?.headMoved === false && out.afterLook?.status === '');
      need('the run ended on a merge commit', a.isMergeCommit === true);
      need('whose second parent is the branch that was merged', a.mergedIncoming === true);
      need('the committed bytes are the per-hunk answer, computed from the conflict', same(a.blob, repo.expectedPerHunkTheirs));
      need('and are NOT the whole incoming file', !same(a.blob, repo.stage3));
      need('and are NOT the whole current file', !same(a.blob, repo.stage2));
      need('nothing was left conflicted', a.status === '' && a.unmerged === '');
      need('and no conflict marker was committed', a.blobHasMarkers === false);
    },
  },

  // 6 -----------------------------------------------------------------------
  //
  // TWO REPOSITORIES, FOR THE TWO WAYS A DRIVER GETS NAMED. Scenarios 6 and 7
  // both used the `attr-driver` fixture, which names its driver through a
  // `.gitattributes` line and never reads `merge.default` at all — so the code
  // path that has to be right about the no-trim / no-empty-collapse reading of
  // `merge.default` was exercised by scenario 8 alone, and reverting that fix
  // left this scenario and the next one both green. The per-hunk refusal is the
  // sharper of the two questions (Stacki has to REFUSE rather than produce
  // something), so it is the one that gets the config-named twin.
  //
  // This is the same scenario asked of two fixtures, not an eleventh scenario:
  // `gitPair` runs both parts under the one id, exactly as scenario 8 does.
  'conflict-driver-refusal': {
    summary: "a custom driver's output is not git's grammar, so per-hunk is refused — named by attribute and by config",
    timeoutMs: 1200000,
    gitPair: ['attr-driver', 'default-empty'],
    async runOne(ctx) {
      const { out, model, effort } = ctx;
      const repo = ctx.repo;

      // --- the control, run first because a refusal costs the fixture nothing --
      const seen = await ctx.rig.app.call('git', { action: 'merge', branch: repo.branch });
      const file = (seen?.files || []).find((f) => f.path === repo.path) || null;
      const answered = await ctx.rig.app.call('git', {
        action: 'resolve_merge',
        mergeRef: seen?.mergeRef,
        choices: { [repo.path]: ['theirs'] },
      });
      const bad = (answered?.badChoices || [])[0] || null;
      out.control = {
        merge: { ok: seen?.ok ?? null, code: seen?.code ?? null, hadMergeRef: typeof seen?.mergeRef === 'string' },
        file: file && { customDriver: file.customDriver ?? null, hunksNull: file.hunks === null, hunkCount: Array.isArray(file.hunks) ? file.hunks.length : null },
        refusal: { ok: answered?.ok ?? null, code: answered?.code ?? null, reason: bad?.reason ?? null, customDriver: bad?.customDriver ?? null },
      };
      out.afterControl = fixtures.observe(repo);

      const host = await ctx.rig.host(
        `This project has a branch called "${repo.branch}". Merge it in. The two branches disagree about ` +
          `${repo.path} — settle it hunk by hunk, taking the incoming branch's side for every hunk. ` +
          'If Stacki will not do it that way, tell me exactly what it said and stop there rather than ' +
          'guessing at something else.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await ctx.rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(ctx.rig.wirePath, ctx.rig.flush);
      out.badChoiceRefusals = (out.wire.refusals || []).filter((r) => r.code === 'bad_choices').length;
      out.after = fixtures.observe(repo);
    },
    checkOne(need, out, ctx) {
      const repo = ctx.repo;
      const a = out.after || {};
      need(`${repo.kind}: the project's own merge driver really ran`, repo.driverRan === true);
      // AND IT IS THE ONE THIS KIND NAMES. `attr-driver` reaches its program
      // through .gitattributes; `default-empty` reaches it through
      // `merge.default = ""`, which is the reading a trim or an empty-collapse
      // gets wrong. Comparing the sentinel the program printed against the label
      // that kind's own config invokes it with is what tells those two apart.
      need(`${repo.kind}: and it is the one this fixture's config names`, repo.driverLabel === repo.expectedDriverLabel && repo.expectedDriverLabel === fixtures.DRIVER_LABEL[repo.kind]);
      // ONE CONDITION, NOT A DISJUNCTION. The `mergeRef` is what the next call
      // needs, so "there was a mergeRef" is the fact worth asserting; `ok ===
      // false || hadMergeRef` was green on either half and said nothing.
      need(`${repo.kind}: CONTROL: git.merge handed back a mergeRef for the conflict`, out.control?.merge?.hadMergeRef === true);
      need(`${repo.kind}: CONTROL: and named the driver on the file`, !!out.control?.file && out.control.file.customDriver === repo.driverName);
      need(`${repo.kind}: CONTROL: and offered no hunks to answer`, out.control?.file?.hunksNull === true);
      need(`${repo.kind}: CONTROL: a per-hunk answer was refused`, out.control?.refusal?.ok === false);
      need(`${repo.kind}: CONTROL: as bad_choices`, out.control?.refusal?.code === 'bad_choices');
      need(`${repo.kind}: CONTROL: for the reason that it cannot be split`, out.control?.refusal?.reason === 'not_splittable');
      need(`${repo.kind}: CONTROL: and the refusal moved nothing`, out.afterControl?.headMoved === false && out.afterControl?.status === '');
      need(`${repo.kind}: the agent was refused for the same reason at least once`, out.badChoiceRefusals > 0);
      // WHATEVER THE AGENT DID NEXT, one thing may never happen: the driver's own
      // text must not become a commit. Either it left the merge alone, or it
      // finished it with one of the two exact sides.
      need(
        `${repo.kind}: the driver’s opaque output was never committed`,
        a.headMoved === false || (a.blobHasDriverSentinel === false && a.blobHasMarkers === false && (same(a.blob, repo.stage2) || same(a.blob, repo.stage3)))
      );
      need(`${repo.kind}: and nothing was left half-merged`, a.unmerged === '');
    },
  },

  // 7 -----------------------------------------------------------------------
  'conflict-driver-theirs': {
    summary: "a custom driver's conflict, settled by an exact whole-file “theirs”",
    timeoutMs: 1200000,
    git: 'attr-driver',
    async run(ctx) {
      const { out, model, effort } = ctx;
      const repo = ctx.repo;
      const seen = await ctx.rig.app.call('git', { action: 'merge', branch: repo.branch });
      const file = (seen?.files || []).find((f) => f.path === repo.path) || null;
      out.merge = { ok: seen?.ok ?? null, customDriver: file?.customDriver ?? null, hunksNull: file ? file.hunks === null : null };
      out.afterLook = fixtures.observe(repo);

      const host = await ctx.rig.host(
        `This project has a branch called "${repo.branch}". Merge it into the branch we are on, and where the two ` +
          `branches disagree about ${repo.path}, take the incoming branch's version of that file in full. ` +
          'Then commit the merge.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await ctx.rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(ctx.rig.wirePath, ctx.rig.flush);
      out.after = fixtures.observe(repo);
    },
    check(need, out, ctx) {
      const repo = ctx.repo;
      const a = out.after || {};
      need("the project's own merge driver really ran", repo.driverRan === true);
      need('and it is the one this fixture’s .gitattributes names', repo.driverLabel === repo.expectedDriverLabel && repo.expectedDriverLabel === fixtures.DRIVER_LABEL[repo.kind]);
      need('and wrote git’s incoming side FIRST, so a misread is detectable', repo.driverWroteIncomingFirst === true);
      need('Stacki named the driver rather than reading its markup', out.merge?.hunksNull === true && out.merge?.customDriver === repo.driverName);
      need('looking at the conflict changed nothing', out.afterLook?.headMoved === false && out.afterLook?.status === '');
      need('the run ended on a merge commit', a.isMergeCommit === true);
      need('whose second parent is the branch that was merged', a.mergedIncoming === true);
      need('the committed bytes are exactly what git held as the incoming side', same(a.blob, repo.stage3));
      need('and are not the current side', !same(a.blob, repo.stage2));
      need("and carry none of the driver's own text", a.blobHasDriverSentinel === false && a.blobHasMarkers === false);
      need('nothing was left conflicted', a.status === '' && a.unmerged === '');
    },
  },

  // 8 -----------------------------------------------------------------------
  //
  // TWO REPOSITORIES, because the two names are two different ways of getting
  // the same fact wrong. `merge.default=""` is a key that IS set, naming the
  // driver under `[merge ""]`; `merge.default=" text "` names one under
  // `[merge " text "]`, whose name is NOT git's built-in `text`. Both run a
  // program on this machine — measured by `--selftest`, which prints the
  // sentinel each one wrote — so both must be treated as opaque.
  'conflict-default-drivers': {
    summary: 'the empty and whitespace merge.default names, both of which git runs as programs',
    timeoutMs: 1200000,
    gitPair: ['default-empty', 'default-space'],
    async runOne(ctx) {
      const { out, model, effort } = ctx;
      const repo = ctx.repo;
      const seen = await ctx.rig.app.call('git', { action: 'merge', branch: repo.branch });
      const file = (seen?.files || []).find((f) => f.path === repo.path) || null;
      out.merge = { ok: seen?.ok ?? null, customDriver: file?.customDriver ?? null, hunksNull: file ? file.hunks === null : null, hasCustomDriverKey: file ? Object.prototype.hasOwnProperty.call(file, 'customDriver') : null };
      out.afterLook = fixtures.observe(repo);

      const host = await ctx.rig.host(
        `This project has a branch called "${repo.branch}". Merge it into the branch we are on, and where the two ` +
          `branches disagree about ${repo.path}, take the incoming branch's version of that file in full. ` +
          'Then commit the merge.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await ctx.rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(ctx.rig.wirePath, ctx.rig.flush);
      out.after = fixtures.observe(repo);
    },
    checkOne(need, out, ctx) {
      const repo = ctx.repo;
      const a = out.after || {};
      need(`${repo.kind}: git really ran the program named by merge.default`, repo.driverRan === true);
      // COMPARED AGAINST THE LABEL THIS KIND'S `[merge …]` SECTION INVOKES IT
      // WITH. `driverRan` and `driverLabel` are read off the same first line of
      // the same file, so "the label is a non-empty string" restated the check
      // above it and could not be red on its own. The expected label can be:
      // `default-empty` and `default-space` configure two different programs
      // under two names that a trim or an empty-collapse would confuse for one
      // another, and this is the assertion that tells them apart.
      need(`${repo.kind}: and it is the program THIS name configures, not the other one`, repo.driverLabel === repo.expectedDriverLabel && repo.expectedDriverLabel === fixtures.DRIVER_LABEL[repo.kind]);
      need(`${repo.kind}: Stacki saw a custom driver on the file`, out.merge?.hasCustomDriverKey === true && out.merge?.customDriver === repo.driverName);
      need(`${repo.kind}: and offered no hunks for it`, out.merge?.hunksNull === true);
      need(`${repo.kind}: looking changed nothing`, out.afterLook?.headMoved === false && out.afterLook?.status === '');
      need(`${repo.kind}: the run ended on a merge commit`, a.isMergeCommit === true);
      need(`${repo.kind}: the committed bytes are exactly git's incoming side`, same(a.blob, repo.stage3));
      need(`${repo.kind}: and not the current side`, !same(a.blob, repo.stage2));
      need(`${repo.kind}: and carry none of the driver's text`, a.blobHasDriverSentinel === false && a.blobHasMarkers === false);
      need(`${repo.kind}: nothing left conflicted`, a.status === '' && a.unmerged === '');
    },
  },

  // 9 -----------------------------------------------------------------------
  'audit-cancel': {
    summary: 'a cancelled audit releases the engine instead of holding the one behind it',
    timeoutMs: 900000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE], [DENSE, densePage()]], log });

      const rig = await openRig({ ws, projectDir, appPath, needPreview: true, log, out });
      ctx.rig = rig;

      // The agent's half: an ordinary audit, so the scenario is a dogfood rather
      // than a unit test with a host attached.
      const host = await rig.host(
        'Audit the /dense page of this site and tell me the most important objective problems with it.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);

      // --- and the controller's half, which is what the checks are about ------
      //
      // Audits are serialised on one shared session, so an abandoned run that is
      // NOT cancelled holds every audit behind it. THAT IS NOW MEASURED RATHER
      // THAN ASSERTED IN A COMMENT: the negative control below fires a long
      // audit, abandons it without cancelling, and requires the short one issued
      // behind it to blow the budget. Only with that half does the cancelled
      // measurement distinguish "the cancel was honoured" from "audits are
      // simply fast on this machine".
      //
      // THE ENVELOPE IS PART OF THE MEASUREMENT, NOT JUST THE CLOCK.
      //
      // `error` was set only for a THROWN exception, and an MCP tool that
      // answers `{ok:false}` does not throw — so `fullError == null && fullMs >
      // 0` was true of an audit engine that refused everything, and
      // `full.value`/`small.value` were captured and never looked at. A
      // completely broken engine passed the two controls this scenario's whole
      // budget is derived from. Now the envelope comes back with the timing and
      // `auditOf` reduces it to the two things worth asserting: it completed,
      // and on the dense page it found something.
      const time = async (fn) => {
        const began = Date.now();
        let value = null;
        let error = null;
        try {
          value = await fn();
        } catch (err) {
          error = String(err?.message || err);
        }
        return { ms: Date.now() - began, value, error };
      };
      const auditOf = (r) => {
        const e = r?.value?.structuredContent ?? null;
        return {
          ok: e?.ok ?? null,
          code: e?.code ?? null,
          findings: Array.isArray(e?.findings) ? e.findings.length : null,
          error: r?.error ?? null,
          ms: r?.ms ?? null,
        };
      };
      const longAudit = () => rig.app.client.callTool({ name: 'audit', arguments: { route: '/dense' } }, { timeout: 300000 });
      const shortAudit = () => rig.app.client.callTool({ name: 'audit', arguments: { route: '/pricing', viewports: ['phone'], rules: [] } }, { timeout: 300000 });

      // WARMED FIRST, because a cold page is slower than a warm one and every
      // comparison here is between two runs of the same route. Measuring `full`
      // cold and cancelling a warm one would overstate how much audit was left
      // at the cut, inflate the budget, and let a cancel that was ignored come
      // in under it — a false green built entirely out of a first page load.
      const warmLong = await time(longAudit);
      const warmShort = await time(shortAudit);
      const full = await time(longAudit);
      const small = await time(shortAudit);
      out.control = {
        warmLongMs: warmLong.ms,
        warmShortMs: warmShort.ms,
        fullMs: full.ms,
        fullError: full.error,
        smallMs: small.ms,
        smallError: small.error,
        warmLong: auditOf(warmLong),
        full: auditOf(full),
        small: auditOf(small),
      };

      const cutMs = 2000;
      const budgetMs = small.ms + Math.max(0, full.ms - cutMs) * 0.5;

      // --- THE NEGATIVE CONTROL, ON THIS SAME APP -----------------------------
      //
      // Without it, "the audit after the cancel came in under the budget" is
      // evidence of cancellation only if audits are actually serialised on one
      // session — which the comment above ASSERTS and nothing measured. If they
      // are not, a short audit is quick whatever happens to the long one, and
      // the cancelled measurement distinguishes nothing.
      //
      // So the same shape is run first with NO cancel: a long audit abandoned in
      // flight, a short one issued at the same cut, and the requirement that
      // this one EXCEEDS the budget. Serialised, it waits out the remainder and
      // comes in around `remaining + small`, which is above `small + remaining
      // *0.5` by half the remainder — at least 2s, given the check below that
      // there was 4s of audit left. Concurrent, it comes in at about `small` and
      // goes red, which is the honest report: the premise this scenario rests on
      // is not true of the app in front of it.
      const blockingRun = time(longAudit);
      await sleep(cutMs);
      const blocked = await time(shortAudit);
      const blocker = await blockingRun;

      const canceller = new AbortController();
      const cancelledRun = time(() => rig.app.client.callTool({ name: 'audit', arguments: { route: '/dense' } }, { timeout: 300000, signal: canceller.signal }));
      await sleep(cutMs);
      canceller.abort(new Error('the controller cancelled this audit'));
      const cancelled = await cancelledRun;
      const afterCancel = await time(shortAudit);
      const stillAlive = await rig.app.call('project', { action: 'info' });

      out.cancel = {
        cutMs,
        cancelledMs: cancelled.ms,
        // THE CLIENT'S OWN REJECTION, AND NOTHING MORE. Aborting the request
        // rejects it locally whatever the server does, so this says the cancel
        // was SENT — the SDK also puts `notifications/cancelled` on the wire —
        // and says nothing about whether it was honoured. `afterCancelMs` below
        // is the only measurement here that is about Stacki.
        cancelledRejected: cancelled.error != null,
        cancelledError: cancelled.error,
        afterCancelMs: afterCancel.ms,
        afterCancelError: afterCancel.error,
        afterCancelAudit: auditOf(afterCancel),
        // WHAT THE ENGINE WOULD HAVE OWED a caller that had to wait the
        // abandoned run out, and the bound the run after the cancel must beat —
        // and, in the negative control above, the bound the run behind an
        // UNCANCELLED audit must exceed.
        remainingMs: Math.max(0, full.ms - cutMs),
        budgetMs,
        blockedMs: blocked.ms,
        blockedError: blocked.error,
        blockedAudit: auditOf(blocked),
        blockerMs: blocker.ms,
        blockerAudit: auditOf(blocker),
        appStillAnswers: stillAlive?.ok === true,
      };
    },
    check(need, out) {
      const c = out.cancel || {};
      need('the agent did audit', (out.wire?.auditCalls || 0) >= 1);
      // COMPLETED, NOT MERELY RETURNED. `{ok:false}` does not throw.
      need('CONTROL: a full audit completed ok', out.control?.fullError == null && out.control?.full?.ok === true && out.control?.fullMs > 0);
      need('CONTROL: and it did real work — the dense page has findings', (out.control?.full?.findings || 0) > 0);
      need('CONTROL: a small audit completed ok', out.control?.smallError == null && out.control?.small?.ok === true && out.control?.smallMs > 0);
      // WITHOUT THIS THE NEXT CHECKS CANNOT BE RED. If the long audit is nearly
      // over by the time the cut lands, "the one after it was quick" is true
      // whether or not anything was cancelled.
      need('there was enough audit left to be worth cancelling', c.remainingMs >= 4000);
      // THE NEGATIVE HALF, WITHOUT WHICH THE POSITIVE ONE PROVES NOTHING.
      need('NEGATIVE CONTROL: an audit issued behind an UNCANCELLED one completed', c.blockedError == null && c.blockedAudit?.ok === true);
      need('NEGATIVE CONTROL: and it had to wait the abandoned one out', c.blockedMs > c.budgetMs);
      need('NEGATIVE CONTROL: the abandoned audit itself finished ok', c.blockerAudit?.ok === true);
      need('the cancelled call really was aborted', c.cancelledRejected === true);
      need('and the audit after it did not wait the abandoned one out', c.afterCancelError == null && c.afterCancelAudit?.ok === true && c.afterCancelMs < c.budgetMs);
      need('and the app still answers', c.appStillAnswers === true);
    },
  },

  // 10 ----------------------------------------------------------------------
  'publish-once': {
    summary: 'git.publish reaches gh exactly once, and the gh it reaches is not real',
    timeoutMs: 900000,
    async run(ctx) {
      const { ws, appPath, out, model, effort, log } = ctx;
      const projectDir = path.join(ws, 'project');
      // Recorded the moment it exists, so a throw part way through this scenario
      // still reaches the teardown check that the directory went.
      out.projectDir = projectDir;
      await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE]], log });
      // A repository, because publishing one that does not exist measures the
      // refusal rather than the boundary.
      const env = fixtures.makeGitEnv(ws);
      const g = (args) => execFileSync('git', args, { cwd: projectDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      g(['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n.astro/\ndist/\n.stacki-automation\n.DS_Store\n', 'utf8');
      g(['add', '--', ...TRACKABLE(projectDir)]);
      g(['commit', '-m', 'the project']);

      const rig = await openRig({ ws, projectDir, appPath, log, out });
      ctx.rig = rig;
      out.repoName = `stacki-final-dogfood-${crypto.randomUUID().slice(0, 8)}`;

      const host = await rig.host(
        `Put this project on GitHub as a NEW PRIVATE repository called "${out.repoName}". Do that once; if it does ` +
          'not work, tell me what happened rather than trying again under another name.',
        { model, effort, timeoutMs: ctx.timeoutMs, tag: null }
      );
      await rig.stopRecorder();
      out.host = hostSummary(host);
      out.wire = readWire(rig.wirePath, rig.flush);
      // READ BEFORE TEARDOWN: `app.stop()` removes the project.
      //
      // AND THE FAILURE IS RECORDED RATHER THAN SWALLOWED. This used to fall
      // back to `''` on any throw, and the check below is a NEGATIVE — "no
      // remote points anywhere but the fake" — so an empty string passed it. A
      // `git remote -v` that could not run at all was therefore vacuously green
      // on exactly the question the scenario exists to answer.
      let remotes = null;
      let remotesError = null;
      try {
        remotes = g(['remote', '-v']);
      } catch (e) {
        remotesError = String(e?.stderr || e?.message || e).slice(0, 300);
      }
      out.remotes = remotes;
      out.remotesError = remotesError;
      // SPLIT HERE, so the check reads lines rather than a haystack. `git remote
      // -v` prints one line per remote per direction: "<name>\t<url> (fetch)".
      out.remoteLines = typeof remotes === 'string' ? remotes.split('\n').map((l) => l.trim()).filter(Boolean) : null;
      out.githubRemoteLines = out.remoteLines ? out.remoteLines.filter((l) => /github\.com/i.test(l)) : null;
      out.publishCalls = (out.wire.rows || []).filter((r) => r.method === 'tools/call' && r.name === 'git' && String(r.args || '').includes('"publish"')).length;
    },
    // The app's gh log arrives with `app.stop()`, so the runner puts it on `out`
    // during teardown and these read it there.
    //
    // "EXACTLY ONCE" IS ABOUT THE INVOCATION THAT CAN CREATE SOMETHING, and that
    // is a measurement rather than a preference. electron/main.js runs `gh
    // --version` before `gh repo create` (main.js:6241), and `gh --version` plus
    // `gh auth status` for `gh_status` (5835, 5841). All three are read-only
    // probes that create nothing. A check demanding ONE invocation in total
    // would therefore have been red for the shipped, correct code path — an
    // oracle mistake, not a finding. So the creating call is counted exactly,
    // and every other entry in the log must be one of those probes: an
    // invocation that is neither is still red, which is the part that matters.
    check(need, out) {
      const calls = out.appGhCalls;
      const isCreate = (argv) => argv[0] === 'repo' && argv[1] === 'create';
      const isVersionProbe = (argv) => argv.length === 1 && argv[0] === '--version';
      const isAuthProbe = (argv) => argv[0] === 'auth' && argv[1] === 'status';
      const creates = Array.isArray(calls) ? calls.filter(isCreate) : null;
      const strays = Array.isArray(calls) ? calls.filter((a) => !isCreate(a) && !isVersionProbe(a) && !isAuthProbe(a)) : null;
      need('the app was contained, so its gh log means something', Array.isArray(calls));
      need('gh created a repository exactly once', Array.isArray(creates) && creates.length === 1);
      need('and every other gh invocation was a read-only probe', Array.isArray(strays) && strays.length === 0);
      need('for the name that was asked for', Array.isArray(creates) && creates.length === 1 && creates[0].includes(out.repoName));
      need('and privately', Array.isArray(creates) && creates.length === 1 && creates[0].includes('--private'));
      need('the agent asked Stacki to publish', out.publishCalls >= 1);
      // THE READ HAS TO HAVE HAPPENED before its answer can be read as one.
      need('the repository could still be asked for its remotes', out.remotesError == null && typeof out.remotes === 'string');
      // EVERY github.com LINE, NOT ONE OF THEM.
      //
      // `!/github\.com/.test(remotes) || /fake-owner\/fake-repo/.test(remotes)`
      // is a disjunction a real remote can stand behind: the moment the fake's
      // URL appears ANYWHERE in the output the whole check is green, including
      // when a second remote beside it points at a real
      // github.com/<owner>/<repo>. The output is split into lines and every
      // line that mentions github.com must be the fake. An empty list passes,
      // which is correct — an agent that published nothing pointed nothing
      // anywhere — and is why `out.remotesError` is asserted separately above.
      need(
        'every remote that points at github.com points at the fake',
        Array.isArray(out.githubRemoteLines) && out.githubRemoteLines.every((l) => /(^|[/:@\s])github\.com[/:]fake-owner\/fake-repo(\.git)?(\s|$)/i.test(l))
      );
      // WAS `credentialsPresentAfter.length === 0`, WHICH WAS A CONSTANT.
      // `containedEnv` throws (host.js:223-224) if any credential survives its
      // strip, so that list is `[]` on every result that exists at all. What can
      // be red is whether the config directory the app's gh was pointed at was
      // one this run owned and one this run took away again: a `GH_CONFIG_DIR`
      // outside tmpdir, or one still sitting on disk after teardown, is a real
      // gh login the next thing to run could pick up.
      need("the app's gh was pointed at a config directory this run owned", typeof out.appContainment?.ghConfigDir === 'string' && out.appContainment.ghConfigDir.startsWith(os.tmpdir()));
      need('and that directory went with the app', typeof out.appContainment?.ghConfigDir === 'string' && !fs.existsSync(out.appContainment.ghConfigDir));
    },
  },
};

// ---------------------------------------------------------------------------
// running one
// ---------------------------------------------------------------------------

async function runScenario({ id, spec, appPath, outDir, model, effort, log }) {
  const ws = path.join(outDir, id);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  const pairs = spec.gitPair || [null];
  const parts = [];
  for (const kind of pairs) {
    const tag = kind ? `${id}/${kind}` : id;
    const partWs = kind ? path.join(ws, kind) : ws;
    fs.mkdirSync(partWs, { recursive: true });
    const out = { id: tag, summary: spec.summary, app: appPath, ok: false, realGh: realGhPath() };
    const ctx = { ws: partWs, appPath, out, model, effort, timeoutMs: spec.timeoutMs, log: (m) => log(`${tag}: ${m}`), rig: null, repo: null };
    let repo = null;

    try {
      const wantGit = kind || spec.git || null;
      if (wantGit) {
        const projectDir = path.join(partWs, 'project');
        // THE PROJECT IS LAID DOWN FIRST, THEN THE REPOSITORY IS BUILT AROUND
        // IT. `corpus.checkout` removes its destination before copying, so
        // seeding from inside `makeConflictRepo` — after `git init` and after
        // the conflict file was written — deleted the `.git` directory and the
        // fixture's own files and then rebuilt a project with no history in it.
        await makeProject(projectDir, { pages: [[PRICING, PRICING_PAGE]], log });
        repo = fixtures.makeConflictRepo({ kind: wantGit, at: projectDir, seed: (root) => TRACKABLE(root), label: tag });
        ctx.repo = repo;
        out.fixture = {
          kind: repo.kind,
          path: repo.path,
          driverName: repo.driverName,
          driverRan: repo.driverRan,
          driverLabel: repo.driverLabel,
          expectedDriverLabel: repo.expectedDriverLabel,
          driverWroteIncomingFirst: repo.driverWroteIncomingFirst,
          headBefore: repo.headBefore,
          incomingCommit: repo.incomingCommit,
          stage2Sha: sha(repo.stage2),
          stage3Sha: sha(repo.stage3),
          perHunkTheirsSha: repo.expectedPerHunkTheirs ? sha(repo.expectedPerHunkTheirs) : null,
        };
        out.projectDir = projectDir;
        ctx.rig = await openRig({ ws: partWs, projectDir, appPath, log: ctx.log, out });
      }
      if (spec.runOne) await spec.runOne(ctx);
      else await spec.run(ctx);
    } catch (err) {
      out.error = String(err?.stack || err).slice(0, 1500);
    } finally {
      const problems = [];
      try {
        if (ctx.rig) {
          // ASKED BEFORE ANYTHING IS TORN DOWN, and of the app rather than of
          // the wire. See `rig.probeLiveness`: an app that died mid-scenario
          // leaves a wire that is indistinguishable from an agent that stopped
          // asking, so the end of every one of the ten now carries one trivial
          // question put to the app through the controller's own MCP client.
          out.liveness = await ctx.rig.probeLiveness();
          const closed = await ctx.rig.close();
          problems.push(...closed.problems);
          out.appGhCalls = closed.stopped?.ghCallsDuringTrial ?? null;
        } else {
          problems.push('the rig never opened');
          // AND WHAT IT LEFT BEHIND WHEN IT DIDN'T. `openRig` stops the app on
          // its way out and now keeps that answer; a stranded preview or a
          // helper process from a rig that refused reaches the results file
          // here instead of being swallowed by the throw.
          if (Array.isArray(out.rigFailure?.problems)) problems.push(...out.rigFailure.problems);
        }
      } catch (e) {
        problems.push(`rig: ${e?.message || e}`);
      }
      try {
        if (repo) problems.push(...repo.cleanup());
      } catch (e) {
        problems.push(`fixture: ${e?.message || e}`);
      }
      // The project directory is `app.stop()`'s to remove; this is the check
      // that it did, and a failure here fails the scenario rather than being
      // left for somebody to find in os.tmpdir().
      try {
        if (out.projectDir && fs.existsSync(out.projectDir)) {
          fs.rmSync(out.projectDir, { recursive: true, force: true });
          if (fs.existsSync(out.projectDir)) problems.push(`${out.projectDir} would not go`);
        }
      } catch (e) {
        problems.push(`project: ${e?.message || e}`);
      }
      out.cleanup = problems;
    }

    const v = [];
    const need = (what, cond) => v.push({ what, ok: cond === true });
    commonChecks(need, out);
    if (!out.error) {
      if (spec.checkOne) spec.checkOne(need, out, ctx);
      else spec.check(need, out, ctx);
    } else {
      need('the scenario ran without throwing', false);
    }
    out.checks = v;
    // A MISSING RESULT IS NOT A PASS. An empty check list, or an error, is red.
    out.ok = v.length > 0 && v.every((c) => c.ok) && !out.error;
    fs.writeFileSync(path.join(partWs, 'result.json'), JSON.stringify(out, null, 2), 'utf8');
    parts.push(out);
  }

  if (parts.length === 1) return parts[0];
  return {
    id,
    summary: spec.summary,
    parts,
    checks: parts.flatMap((p) => p.checks || []),
    cleanup: parts.flatMap((p) => p.cleanup || []),
    ok: parts.length === pairs.length && parts.every((p) => p.ok),
  };
}

// ---------------------------------------------------------------------------
// the self-test: the pure-git machinery, with no agent and no app in it
// ---------------------------------------------------------------------------

/**
 * Build every conflict fixture and say what git actually did with it.
 *
 * This is the part that has to be right. The agent-driving half of this file is
 * mechanical — start an app, hand a brief to a host, read the repository
 * afterwards — but every one of those readings is meaningless if the fixture
 * did not really run a merge driver, or really not run one, or if the sides are
 * not what the harness believes.
 */
function selftest() {
  const problems = [];
  const say = (m) => process.stdout.write(`${m}\n`);
  const check = (what, cond) => {
    if (!cond) problems.push(what);
    say(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
  };
  const head = (buf, lines = 3) =>
    buf
      .toString('utf8')
      .split('\n')
      .slice(0, lines)
      .map((l) => `        ${JSON.stringify(l)}`)
      .join('\n');

  say(`git ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}  ·  node ${process.version}\n`);

  for (const kind of fixtures.KINDS) {
    say(`--- ${kind}`);
    let repo = null;
    try {
      repo = fixtures.makeConflictRepo({ kind });
      say(`    repo ${repo.root}`);
      say(`    driver name        ${repo.driverName === null ? '(none)' : JSON.stringify(repo.driverName)}`);
      say(`    driver ran         ${repo.driverRan}  ${repo.driverLabel ? `(sentinel ${JSON.stringify(repo.driverLabel)})` : ''}`);
      say(`    HEAD before        ${repo.headBefore}`);
      say(`    incoming commit    ${repo.incomingCommit}`);
      say(`    stage 1 (base)     ${repo.stage1.length}B  ${short(sha(repo.stage1))}`);
      say(`    stage 2 (current)  ${repo.stage2.length}B  ${short(sha(repo.stage2))}`);
      say(head(repo.stage2, 3));
      say(`    stage 3 (incoming) ${repo.stage3.length}B  ${short(sha(repo.stage3))}`);
      say(head(repo.stage3, 3));
      say(`    worktree after the conflicting merge (${Buffer.byteLength(repo.conflicted)}B), first 6 lines:`);
      say(head(Buffer.from(repo.conflicted, 'utf8'), 6));
      if (repo.expectedPerHunkTheirs) {
        say(`    per-hunk "theirs"  ${repo.expectedPerHunkTheirs.length}B  ${short(sha(repo.expectedPerHunkTheirs))}`);
        say(head(repo.expectedPerHunkTheirs, 3));
      } else {
        say('    per-hunk "theirs"  (not computed: the driver’s output is not git’s grammar)');
      }

      // THE ASSERTION THE WHOLE OF SCENARIO 8 RESTS ON.
      check(`${kind}: the driver ${repo.expectDriver ? 'ran' : 'did NOT run'}`, repo.driverRan === repo.expectDriver);
      if (repo.expectDriver) {
        // COMPARED AGAINST GIT'S INDEX, not against the labels the driver
        // prints. See gitFixtures.js: the label version of this check stayed
        // green when the sides were swapped.
        check(`${kind}: the driver wrote git's incoming side above the separator and the current side below`, repo.driverWroteIncomingFirst === true);
        // AND THAT IT IS THE ONE THIS KIND CONFIGURED. `driverRan` and
        // `driverLabel` come out of the same first line of the same file, so
        // asserting the label is a non-empty string said nothing new; asserting
        // it against the label this kind's own `[merge …]` section prints is red
        // when git resolved the merge through a different section than the one
        // under test.
        check(`${kind}: and it is the driver this kind's config names, not another`, repo.driverLabel === repo.expectedDriverLabel && repo.expectedDriverLabel === fixtures.DRIVER_LABEL[kind]);
      } else {
        check(`${kind}: git wrote its own diff3 markup`, /^\|{7}/m.test(repo.conflicted) && /^<{7} /m.test(repo.conflicted));
        check(`${kind}: with no driver sentinel in it`, !repo.conflicted.includes(fixtures.SENTINEL));
        check(`${kind}: per-hunk "theirs" differs from BOTH whole-file sides`, !repo.expectedPerHunkTheirs.equals(repo.stage2) && !repo.expectedPerHunkTheirs.equals(repo.stage3));
        check(`${kind}: and it keeps the current branch's region A`, repo.expectedPerHunkTheirs.toString('utf8').includes('Region A — current branch rewrote this'));
        check(`${kind}: and takes the incoming branch's region B`, repo.expectedPerHunkTheirs.toString('utf8').includes('Region B — incoming branch rewrote this'));
      }
      check(`${kind}: the two sides are different bytes`, !repo.stage2.equals(repo.stage3));
      check(`${kind}: stage 2 is this branch's committed file`, repo.stage2.toString('utf8') === fixtures.CURRENT);
      check(`${kind}: stage 3 is the incoming branch's committed file`, repo.stage3.toString('utf8') === fixtures.INCOMING);
      check(`${kind}: the trial merge was unwound — HEAD is where it was`, repo.git(['rev-parse', 'HEAD']) === repo.headBefore);
      check(`${kind}: and the tree is clean`, repo.git(['status', '--porcelain']) === '');
      check(`${kind}: git.merge would still find the conflict`, repo.git(['rev-parse', 'incoming']) === repo.incomingCommit);
    } catch (err) {
      problems.push(`${kind}: threw — ${err?.message || err}`);
      say(`  FAIL ${kind}: ${err?.message || err}`);
    } finally {
      if (repo) {
        const left = repo.cleanup();
        check(`${kind}: everything it made was removed`, left.length === 0);
      }
    }
    say('');
  }

  // AND THE PARSER THE EXPECTATION IS COMPUTED WITH, tested where it must say no.
  say('--- the conflict-block reader');
  const mustThrow = (what, text) => {
    let threw = false;
    try {
      fixtures.resolveBlocks(text, 'theirs');
    } catch {
      threw = true;
    }
    check(what, threw);
  };
  mustThrow('a block that is never closed is refused', '<<<<<<< a\nx\n=======\ny\n');
  mustThrow('a separator outside a block is refused', 'x\n=======\ny\n');
  mustThrow('a file with no conflict at all is refused', 'nothing here\n');
  check(
    'a diff3 block resolves to the side below the separator',
    fixtures.resolveBlocks('top\n<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> other\nend\n', 'theirs') === 'top\ntheirs\nend\n'
  );
  check(
    'and "ours" is the side above the ancestor line',
    fixtures.resolveBlocks('top\n<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> other\nend\n', 'ours') === 'top\nours\nend\n'
  );

  say('');
  if (problems.length) {
    say(`selftest: ${problems.length} FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  say('selftest: every fixture behaved as the harness assumes');
  return 0;
}

// ---------------------------------------------------------------------------

// EXPORTED, AND THE ENTRY POINT GUARDED, SO THE ORACLES CAN BE SHOWN FAILING.
//
// Running this file as a script is unchanged: `require.main === module` is true
// then and the block below runs exactly as it did. What the export buys is the
// only thing that makes a check credible — a demonstration that it can be RED.
// A check nobody has ever seen fail is a check nobody has evidence about, and
// five rounds of this file's history are checks that turned out to be incapable
// of failing. `commonChecks`, `readWire` and `settleFile` are the oracles that
// grade every one of the ten, so they are the ones that must be mutable under a
// deliberate sabotage.
module.exports = { commonChecks, readWire, settleFile, openRig, probeShadow, watchFile, whenWireShows, SCENARIOS, FAKE_GH };

const main = async () => {
  if (flag('selftest')) {
    process.exit(selftest());
    return;
  }

  const appPath = path.resolve(REPO, arg('app', APP));
  const outDir = path.resolve(arg('out', path.join(os.tmpdir(), `stacki-final-blockers-${Date.now()}`)));
  const model = arg('model', 'opus');
  const effort = arg('effort', 'max');
  const only = (arg('only', '') || '').split(',').filter(Boolean);
  const log = (m) => process.stdout.write(`  ${m}\n`);

  const unknown = only.filter((id) => !SCENARIOS[id]);
  if (unknown.length) {
    console.error(`final-blockers: no such scenario: ${unknown.join(', ')}`);
    console.error(`  have: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  if (!available(appPath)) {
    console.error(`final-blockers: no packaged app at ${appPath}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`final-blockers: ${appPath}`);
  console.log(`  claude ${claudeVersion()} · model ${model} · effort ${effort}`);
  console.log(`  credentials stripped from every child: ${CREDENTIAL_VARS.join(', ')}`);
  console.log(`  out ${outDir}\n`);

  const chosen = Object.entries(SCENARIOS).filter(([id]) => !only.length || only.includes(id));
  const results = [];
  for (const [id, spec] of chosen) {
    console.log(`--- ${id}  ·  ${spec.summary}`);
    let r;
    try {
      r = await runScenario({ id, spec, appPath, outDir, model, effort, log });
    } catch (err) {
      // A SCENARIO THAT COULD NOT EVEN BE SET UP IS A FAILED SCENARIO, with a
      // check that says so, rather than a gap in the results file.
      r = { id, summary: spec.summary, ok: false, error: String(err?.stack || err).slice(0, 1500), checks: [{ what: 'the scenario could be set up', ok: false }] };
    }
    results.push(r);
    for (const c of r.checks || []) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}`);
    if (r.error) console.log(`  error: ${String(r.error).split('\n')[0]}`);
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}\n`);
    await sleep(1500);
  }

  fs.writeFileSync(path.join(outDir, 'all.json'), JSON.stringify({ appPath, model, effort, claude: claudeVersion(), results }, null, 2), 'utf8');

  const expected = chosen.length;
  const passed = results.filter((r) => r.ok).length;
  const cleanupProblems = results.flatMap((r) => r.cleanup || []);
  console.log('final-blockers summary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
  if (cleanupProblems.length) {
    console.log('  cleanup problems:');
    for (const p of cleanupProblems) console.log(`    - ${p}`);
  }
  console.log(`\n${passed}/${expected} scenarios passed  ·  ${outDir}`);
  // TRUE EXIT STATUS. A missing result is not a pass, and a cleanup failure is
  // not a footnote.
  process.exit(passed === expected && results.length === expected && cleanupProblems.length === 0 ? 0 : 1);
};

if (require.main === module) {
  main().catch((err) => {
    console.error('final-blockers: threw\n', err?.stack || err);
    process.exit(1);
  });
}
