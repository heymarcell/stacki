// The four blockers, put back in front of a real Claude Code.
//
//   node scripts/eval/blockers/native.js --app=release/mac-universal/Stacki.app --out=<dir>
//   node scripts/eval/blockers/native.js --only=audit-dense,probe-off-origin
//
// The deterministic suites (test/audit-byte-budget.js, test/source-fidelity.js,
// test/undo-bytes.js, test/probe-origin-fence.js) prove the fixes against the
// engine. They cannot prove the thing the dogfood actually measured, which is
// what happens when a REAL host is handed the answer: 19 of 72 audit calls were
// refused by Claude Code itself, and no amount of testing Stacki against Stacki
// would have found that.
//
// So this is the narrow rerun. Same isolation as the campaign it comes from --
// the packaged app, a recording proxy the server cannot see, a fresh Claude Code
// per slice with no filesystem, shell or browser tools and no user configuration
// -- and seven slices rather than forty-seven, chosen because they are the ones
// the fixes could have broken.
//
// THE ORACLES ARE THE CONTROLLER'S, NOT THE AGENT'S. The agent is asked an
// ordinary question in ordinary words; what counts is the file's hash before and
// after, the request counter on a server the agent has never heard of, and the
// response sizes read off the wire. Nothing here believes a sentence the model
// wrote about its own work.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const corpus = require(path.join(REPO, 'scripts/eval/heldout/corpus.js'));
const { createRecorder } = require(path.join(REPO, 'scripts/eval/heldout/recorder.js'));
const { runHost, claudeVersion } = require(path.join(REPO, 'scripts/eval/heldout/host.js'));
const { startPackagedApp, available, APP } = require(path.join(REPO, 'test/support/packagedApp.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const short = (h) => (h ? h.slice(0, 12) : null);

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
// The pages the slices are about
// ---------------------------------------------------------------------------

// A PAGE DENSE ENOUGH TO HAVE BROKEN THE HOST. The dogfood's oversize answers
// came off real pages with hundreds of nodes; this one is built to the same
// shape -- many elements each carrying a real, objective, machine-checkable
// defect, with long class lists so the selectors axe emits are the length real
// selectors are.
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

// The shape the source-fidelity blocker was measured on: comments sitting
// directly above the imports they annotate, four-space indentation, and
// single-quoted attributes. All three are what a whole-file re-serialization
// destroys.
const FIDELITY_PAGE = `---
// Layout import - the shell every page shares
import Layout from '../layouts/Layout.astro';

// Component imports
import Card from '../components/Card.astro';

// Page copy, kept together so it is easy to find
const heading = 'Pricing';
const plans = [
    { name: 'Starter', price: 9 },
    { name: 'Team', price: 29 },
];
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

const CARD_COMPONENT = `---
const { title, price } = Astro.props;
---
<article class="card">
  <h3>{title}</h3>
  <p>{price}</p>
</article>
`;

const LAYOUT = `---
const { title } = Astro.props;
---
<html lang="en">
  <head><title>{title}</title></head>
  <body><slot /></body>
</html>
`;

// A route on the PROJECT that redirects off it. The audit refuses this and the
// outside origin receives nothing; project.probe used to fetch it.
const redirectOut = (outsideUrl) => `---
return Astro.redirect('${outsideUrl}/landed');
---
`;

/** The outside origin. It exists to be counted, and it is proven countable. */
function outsideOrigin() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, at: Date.now() });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>outside</title><p>outside</p>');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      done({
        server,
        port,
        hits,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((shut) => server.close(shut)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The slices
// ---------------------------------------------------------------------------
//
// Each brief is what a person would type. None of them names an operation, a
// ref, a tool or an expected finding -- an agent told which door to walk
// through has not demonstrated that it could find the door.

const SLICES = [
  {
    id: 'audit-dense',
    access: 'edit',
    timeoutMs: 900000,
    brief:
      'Audit the /dense page of this site and tell me the important objective problems with it. ' +
      'Say clearly whether the result you got back was truncated, and if it was, what was left out and why. ' +
      'Then tell me what you would fix first.',
  },
  {
    id: 'prop-edit',
    access: 'edit',
    timeoutMs: 900000,
    brief:
      'On the /pricing page, the pricing card is showing the wrong price. Change the card so it shows 12 instead of 9. ' +
      'Change nothing else about the page.',
  },
  {
    id: 'edit-undo',
    access: 'edit',
    timeoutMs: 900000,
    brief:
      'On the /pricing page, change the pricing card so it shows 12 instead of 9. ' +
      'Then undo that change and verify the page is back exactly as it was before you touched it. ' +
      'Tell me how you verified it.',
  },
  {
    id: 'probe-normal',
    access: 'inspect',
    timeoutMs: 600000,
    brief: 'Is the preview for this project actually answering right now? Check it and tell me what you found.',
  },
  {
    id: 'probe-off-origin',
    access: 'inspect',
    timeoutMs: 600000,
    brief:
      'The /redirect-out route on this site is behaving oddly. Check whether it is answering, and tell me exactly what happened when you tried.',
  },
  {
    id: 'audit-fix-audit',
    access: 'edit',
    timeoutMs: 1200000,
    brief:
      'Audit the /pricing page, fix the most clear-cut objective accessibility problem you find there, ' +
      'and then audit it again to show the problem is gone. Tell me which finding you fixed and how you know it cleared.',
  },
  {
    id: 'flagship',
    access: 'edit',
    timeoutMs: 1200000,
    brief:
      'Have a look at the /pricing page of this project, tell me what it is made of, ' +
      'give the main heading a clearer wording, check that the change actually reached the served page, ' +
      'and then put it back the way it was.',
  },
];

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

const PRICING = 'src/pages/pricing.astro';

async function runSlice({ slice, appPath, outDir, model, effort, log }) {
  const ws = path.join(outDir, slice.id);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  const out = { id: slice.id, access: slice.access, app: appPath, ok: false };
  let app = null;
  let recorder = null;
  let outside = null;
  const projectDir = path.join(ws, 'project');

  try {
    outside = await outsideOrigin();
    // THE COUNTER IS PROVEN ABLE TO MOVE before anything is asserted about it
    // staying still. The campaign this comes from shipped a sink bound at port
    // zero, so `hits === 0` was true by construction; that is not repeated.
    const live = await fetch(`${outside.origin}/liveness`);
    await live.arrayBuffer();
    out.outsideCounterWorks = live.status === 200 && outside.hits.length === 1;

    const source = await corpus.project('astro-portfolio', { log });
    out.projectHash = source.contentHash;
    corpus.checkout(source.root, projectDir);

    // The pages the slices are about, written into a real project with real
    // dependencies so the dev server, the renderer and the audit are all real.
    const put = (rel, text) => {
      const full = path.join(projectDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    };
    put('src/pages/dense.astro', densePage());
    put('src/layouts/Layout.astro', LAYOUT);
    put('src/components/Card.astro', CARD_COMPONENT);
    put(PRICING, FIDELITY_PAGE);
    put('src/pages/redirect-out.astro', redirectOut(outside.origin));

    const before = fs.readFileSync(path.join(projectDir, PRICING), 'utf8');
    out.pricingBefore = sha(before);
    const outsideAtStart = outside.hits.length;

    const port = await freePort(45200 + ((process.pid % 40) * 8));
    app = await startPackagedApp({ access: slice.access, project: projectDir, app: appPath, portFrom: port });
    out.appUrl = app.url;
    log(`${slice.id}: app on ${app.url}`);
    if (slice.access !== 'visual') await app.untilOpen();
    const ready = await app.untilPreviewReady();
    out.previewStatus = ready?.status || null;

    const wirePath = path.join(ws, 'wire.jsonl');
    const proxyPort = await freePort(48200 + ((process.pid % 40) * 8));
    recorder = createRecorder({ upstreamUrl: app.url, token: app.token, port: proxyPort, logPath: wirePath });
    await recorder.start();

    fs.writeFileSync(path.join(ws, 'BRIEF.md'), slice.brief, 'utf8');
    const config = writeSafeConfig(ws, recorder.url);
    const host = await runHost({
      workspace: ws,
      url: recorder.url,
      token: app.token,
      configPath: config,
      env: { STACKI_MCP_TOKEN: app.token },
      prompt: slice.brief,
      mode: 'mcp-only',
      model,
      effort,
      timeoutMs: slice.timeoutMs,
      log: (m) => log(`${slice.id}: ${m}`),
    });
    await recorder.stop();
    recorder = null;

    const rows = wireRows(wirePath);
    const calls = rows.filter((r) => r.method === 'tools/call');
    const audits = calls.filter((r) => r.name === 'audit');

    out.host = {
      ok: host.ok,
      turns: host.turns,
      elapsedMs: host.elapsedMs,
      timedOut: host.timedOut,
      builtinToolCalls: host.builtinToolCalls,
      builtinUsed: host.builtinUsed,
      mcpToolCalls: host.mcpToolCalls,
      toolUse: host.toolUse,
      text: host.text,
    };
    // THE ISOLATION CLAIM, CHECKED. Anything that is not an MCP call, an MCP
    // resource door or the structured-answer tool is the model reaching outside
    // Stacki, and this run has none of those tools at all.
    out.isolationHeld = host.builtinToolCalls === 0;
    out.wire = {
      calls: calls.length,
      auditCalls: audits.length,
      maxResponseBytes: rows.reduce((n, r) => Math.max(n, r.responseBytes || 0), 0),
      maxAuditResponseBytes: audits.reduce((n, r) => Math.max(n, r.responseBytes || 0), 0),
      refusals: calls.filter((r) => r.envelopeNotOk).map((r) => ({ name: r.name, code: r.refusalCode })),
      protocolErrors: rows.filter((r) => r.protocolError).length,
    };
    // THE DEFECT, IN THE HOST'S OWN WORDS. Claude Code refuses an oversize
    // result with this sentence and hands the agent an error instead of the
    // audit; in MCP-purity mode it has no tool that can read the file the host
    // wrote it to.
    const said = `${host.text || ''}\n${host.stderr || ''}`;
    out.hostReceiveErrors = (said.match(/exceeds maximum allowed (?:tokens|output)/gi) || []).length;

    const after = fs.readFileSync(path.join(projectDir, PRICING), 'utf8');
    out.pricingAfter = sha(after);
    out.pricingChanged = out.pricingAfter !== out.pricingBefore;
    out.pricingRestored = out.pricingAfter === out.pricingBefore;
    out.diff = (() => {
      let head = 0;
      while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
      let tail = 0;
      while (
        tail < before.length - head &&
        tail < after.length - head &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail]
      ) {
        tail += 1;
      }
      const a = before.split('\n');
      const b = after.split('\n');
      let lh = 0;
      while (lh < a.length && lh < b.length && a[lh] === b[lh]) lh += 1;
      let lt = 0;
      while (lt < a.length - lh && lt < b.length - lh && a[a.length - 1 - lt] === b[b.length - 1 - lt]) lt += 1;
      return {
        removedBytes: before.length - head - tail,
        addedBytes: after.length - head - tail,
        removedLines: a.length - lh - lt,
        addedLines: b.length - lh - lt,
      };
    })();
    // The three comments that the whole-file rewrite used to detach from the
    // imports they annotate.
    out.commentsIntact =
      /\/\/ Layout import - the shell every page shares\nimport Layout/.test(after) &&
      /\/\/ Component imports\nimport Card/.test(after);
    out.quotesIntact = after.includes("class='pricing'") && after.includes("class='comparison'");
    out.indentIntact = after.includes("\n    <section class='pricing'>");

    out.outsideHits = outside.hits.length - outsideAtStart;
    out.outsideReached = outside.hits.slice(outsideAtStart).map((h) => h.url);
  } catch (err) {
    out.error = String(err?.stack || err).slice(0, 1200);
  } finally {
    const problems = [];
    try {
      if (recorder) await recorder.stop();
    } catch (e) {
      problems.push(`recorder: ${e?.message || e}`);
    }
    try {
      if (app) {
        const stopped = await app.stop();
        if (stopped?.problems?.length) problems.push(...stopped.problems);
      }
    } catch (e) {
      problems.push(`app: ${e?.message || e}`);
    }
    try {
      if (outside) await outside.close();
      if (outside && outside.server.listening) problems.push('outside origin still listening');
    } catch (e) {
      problems.push(`outside: ${e?.message || e}`);
    }
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
      if (fs.existsSync(projectDir)) problems.push('project directory still on disk');
    } catch (e) {
      problems.push(`project: ${e?.message || e}`);
    }
    // Cleanup failure is trial failure, recorded per trial rather than summed.
    out.cleanup = problems;
  }

  // --- THE VERDICT, PER SLICE. Every one of these reads the world rather than
  //     the agent's account of it.
  const v = [];
  const need = (what, cond) => v.push({ what, ok: !!cond });
  need('no built-in tool call', out.isolationHeld === true);
  need('no cleanup problem', Array.isArray(out.cleanup) && out.cleanup.length === 0);
  need('the host received every result', out.hostReceiveErrors === 0);
  need('the outside counter can move', out.outsideCounterWorks === true);

  switch (slice.id) {
    case 'audit-dense':
      need('the agent actually audited', out.wire?.auditCalls > 0);
      need('every audit answer fitted through the host', (out.wire?.maxAuditResponseBytes || 0) < 52640);
      need('and nothing else was oversize either', (out.wire?.maxResponseBytes || 0) < 52640);
      break;
    case 'prop-edit':
      need('the price really changed on disk', out.pricingChanged === true);
      need('the diff is local', out.diff.removedLines <= 3 && out.diff.addedLines <= 3);
      need('the frontmatter comments are where they were', out.commentsIntact === true);
      need('the quotes elsewhere are untouched', out.quotesIntact === true);
      need('the indentation is untouched', out.indentIntact === true);
      break;
    case 'edit-undo':
      need('the file is byte-identical to before', out.pricingRestored === true);
      break;
    case 'probe-normal':
      need('the preview answered', out.previewStatus === 200);
      need('nothing left the project', out.outsideHits === 0);
      break;
    case 'probe-off-origin':
      need('the outside origin received nothing', out.outsideHits === 0);
      need('and Stacki refused rather than fetching', (out.wire?.refusals || []).length > 0);
      break;
    case 'audit-fix-audit':
      need('the agent audited more than once', out.wire?.auditCalls >= 2);
      need('and every answer fitted', (out.wire?.maxAuditResponseBytes || 0) < 52640);
      need('and it changed the page', out.pricingChanged === true);
      break;
    case 'flagship':
      need('the agent did real work', (out.wire?.calls || 0) >= 4);
      need('and put the page back', out.pricingRestored === true);
      break;
    default:
      break;
  }
  out.checks = v;
  out.ok = v.every((c) => c.ok);
  fs.writeFileSync(path.join(ws, 'result.json'), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

(async () => {
  const appPath = path.resolve(REPO, arg('app', APP));
  const outDir = path.resolve(arg('out', path.join(os.tmpdir(), `stacki-native-blockers-${Date.now()}`)));
  const model = arg('model', 'opus');
  const effort = arg('effort', 'max');
  const only = (arg('only', '') || '').split(',').filter(Boolean);
  const log = (m) => process.stdout.write(`  ${m}\n`);

  if (!available(appPath)) {
    console.error(`native-blockers: no packaged app at ${appPath}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`native-blockers: ${appPath}`);
  console.log(`  claude ${claudeVersion()} · model ${model} · effort ${effort}`);
  console.log(`  out ${outDir}\n`);

  const chosen = SLICES.filter((s) => !only.length || only.includes(s.id));
  const results = [];
  for (const slice of chosen) {
    console.log(`--- ${slice.id}`);
    const r = await runSlice({ slice, appPath, outDir, model, effort, log });
    results.push(r);
    for (const c of r.checks || []) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.what}`);
    if (r.error) console.log(`  error: ${r.error.split('\n')[0]}`);
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'} · calls ${r.wire?.calls ?? '-'} · audits ${r.wire?.auditCalls ?? '-'} · ` +
        `max result ${r.wire?.maxResponseBytes ?? '-'}B · escapes ${r.host?.builtinToolCalls ?? '-'} · ` +
        `outside ${r.outsideHits ?? '-'} · ${short(r.pricingBefore)} -> ${short(r.pricingAfter)}\n`
    );
    await sleep(1500);
  }

  fs.writeFileSync(path.join(outDir, 'all.json'), JSON.stringify({ appPath, model, effort, results }, null, 2), 'utf8');
  const passed = results.filter((r) => r.ok).length;
  console.log(`native-blockers: ${passed}/${results.length} slices passed  ·  ${outDir}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error('native-blockers: threw\n', err?.stack || err);
  process.exit(1);
});
