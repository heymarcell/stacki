// What the shipped audit says about projects nobody wrote for it.
//
//   node scripts/eval/heldout/audit-survey.js [--app=<Stacki.app>] [--projects=a,b]
//
// The audit's own fixture is seeded: every defect in it was put there to be
// found, and every control was put there to not be. That proves the detectors
// do what they say on the shape they were written against. It cannot say
// whether they are USEFUL on a page somebody else wrote, whether they are quiet
// when they should be, or what they walk straight past.
//
// This runs the real engine, out of the real packaged app, over the held-out
// corpus, at every viewport, and prints what came back — plus a small set of
// independent observations taken from the served HTML that the audit does NOT
// make, so a gap is visible as a gap rather than as an absence.
//
// It changes nothing. Every project is a disposable copy and every audit is
// side-effect free by construction.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const REPO = path.resolve(__dirname, '..', '..', '..');
const corpus = require('./corpus.js');
const { startPackagedApp, available, APP } = require(path.join(REPO, 'test/support/packagedApp.js'));

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const get = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message), type: '' }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout', type: '' });
    });
  });

const head = (url) =>
  new Promise((resolve) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });

/**
 * Observations the audit does not make, taken from the document it measured.
 *
 * Deliberately narrow and deliberately mechanical: each is either true or it is
 * not, and none of them is a judgement about how the page looks. They exist to
 * answer one question — when this engine says a page is clean, what could still
 * be wrong with it that anybody would call a defect?
 */
async function independentLook(previewUrl, route) {
  const page = await get(previewUrl + route);
  if (page.status !== 200) return { route, status: page.status, note: 'not served' };
  const html = page.body;

  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const srcs = imgs
    .map((tag) => /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1] || null)
    .filter((s) => s && !s.startsWith('data:'));
  const broken = [];
  for (const src of srcs) {
    const url = src.startsWith('http') ? src : previewUrl + (src.startsWith('/') ? src : `/${src}`);
    // Only the project's own assets: a remote image that does not answer says
    // something about this machine's network, not about the page.
    if (!url.startsWith(previewUrl)) continue;
    const status = await head(url);
    if (status !== 200) broken.push({ src, status });
  }

  return {
    route,
    status: page.status,
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    images: srcs.length,
    brokenSameOriginImages: broken,
    // A page that serves 200 and renders nothing is indistinguishable from a
    // perfect page in the current payload. This is the cheapest possible look
    // at whether that ever happens on a real project.
    bodyTextChars: (html.match(/<body[\s\S]*<\/body>/i)?.[0] || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim().length,
  };
}

async function surveyOne({ id, appPath, viewports, out, log }) {
  const source = await corpus.project(id, { log });
  const dir = path.join(out, `survey-${id}`);
  const projectDir = path.join(dir, 'project');
  fs.mkdirSync(dir, { recursive: true });
  corpus.checkout(source.root, projectDir);

  const record = { project: id, hash: source.contentHash, astro: source.astro, routes: [], findings: [], errors: [] };
  let app = null;
  try {
    app = await startPackagedApp({ access: 'edit', project: projectDir, app: appPath, portFrom: 44800 });
    await app.untilOpen();
    await app.untilPreviewReady();
    const preview = (() => {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(projectDir, '.astro', 'dev.json'), 'utf8'));
        return lock?.port ? `http://127.0.0.1:${lock.port}` : null;
      } catch {
        return null;
      }
    })();
    record.preview = preview;

    const pages = await app.run('page', 'list');
    // A dynamic route cannot be audited by its pattern; it needs one of the
    // pages it actually generates, and `project.scan` does not know them
    // either. Static routes only, and the count of what was skipped is
    // reported rather than dropped.
    const routes = (pages?.pages || []).filter((p) => !p.dynamic).map((p) => p.route);
    record.skippedDynamic = (pages?.pages || []).filter((p) => p.dynamic).map((p) => p.route);

    for (const route of routes) {
      const answer = await app.call('audit', { route, viewports, capture: false });
      const look = preview ? await independentLook(preview, route) : null;
      record.routes.push({
        route,
        ok: answer?.ok,
        code: answer?.code || null,
        findingCount: answer?.findingCount ?? null,
        returned: (answer?.findings || []).length,
        counts: answer?.counts || null,
        truncated: answer?.truncation?.truncated ?? null,
        perViewport: (answer?.perViewport || []).map((v) => ({
          key: v.viewport?.key ?? v.key,
          overflows: v.overflows,
          overflowBy: v.overflowBy,
        })),
        look,
      });
      for (const f of answer?.findings || []) {
        record.findings.push({
          route,
          kind: f.kind,
          severity: f.severity,
          ruleId: f.ruleId,
          standard: f.standard,
          viewport: f.viewport?.key,
          selector: f.target?.selector || null,
          modelPath: f.target?.modelPath || null,
          exact: f.target?.exact ?? null,
        });
      }
    }
  } catch (err) {
    record.errors.push(String(err?.stack || err?.message || err));
  } finally {
    if (app) {
      const said = await app.stop().catch((e) => ({ problems: [String(e?.message || e)] }));
      record.cleanupProblems = said?.problems || [];
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, 'survey.json'), JSON.stringify(record, null, 1), 'utf8');
  return record;
}

async function main() {
  const appPath = arg('app', APP);
  const out = arg('out', path.join(require('node:os').tmpdir(), 'stacki-audit-survey'));
  const viewports = (arg('viewports', 'phone,tablet,desktop') || '').split(',').filter(Boolean);
  const ids = (arg('projects') || corpus.MANIFEST.corpus.projects.map((p) => p.id).join(',')).split(',');
  if (!available(appPath)) {
    console.error(`no packaged app at ${appPath}`);
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const log = (m) => console.log(`survey: ${m}`);

  const all = [];
  for (const id of ids) {
    log(`auditing ${id} at ${viewports.join(', ')}`);
    const r = await surveyOne({ id, appPath, viewports, out, log });
    all.push(r);
    for (const route of r.routes) {
      console.log(
        `  ${route.route.padEnd(28)} ok=${route.ok} findings=${route.findingCount} returned=${route.returned} ` +
          `counts=${JSON.stringify(route.counts)} ` +
          `overflow=${route.perViewport.filter((v) => v.overflows).map((v) => v.key).join('/') || 'none'} ` +
          `text=${route.look?.bodyTextChars ?? '-'}ch imgs=${route.look?.images ?? '-'}` +
          (route.look?.brokenSameOriginImages?.length ? ` BROKEN-IMG=${JSON.stringify(route.look.brokenSameOriginImages)}` : '')
      );
    }
    if (r.errors.length) console.log(`  errors: ${r.errors.join(' | ')}`);
    if ((r.cleanupProblems || []).length) console.log(`  cleanup: ${r.cleanupProblems.join('; ')}`);
  }

  console.log('\n=== EVERY FINDING, BY RULE ===\n');
  const byRule = {};
  for (const r of all) {
    for (const f of r.findings) {
      const key = `${f.kind}/${f.ruleId}`;
      byRule[key] = byRule[key] || { n: 0, withModelPath: 0, exact: 0, viewports: new Set(), projects: new Set() };
      byRule[key].n += 1;
      if (f.modelPath) byRule[key].withModelPath += 1;
      if (f.exact) byRule[key].exact += 1;
      byRule[key].viewports.add(f.viewport);
      byRule[key].projects.add(r.project);
    }
  }
  for (const [key, v] of Object.entries(byRule).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `${key.padEnd(34)} n=${String(v.n).padStart(4)}  modelPath=${String(v.withModelPath).padStart(4)}  exact=${String(v.exact).padStart(4)}  ` +
        `viewports=${[...v.viewports].join('/')}  projects=${[...v.projects].join(',')}`
    );
  }

  console.log('\n=== WHAT THE AUDIT DID NOT SAY ===\n');
  for (const r of all) {
    for (const route of r.routes) {
      const l = route.look;
      if (!l) continue;
      if (l.brokenSameOriginImages?.length) {
        console.log(`${r.project} ${route.route}: ${l.brokenSameOriginImages.length} same-origin image(s) that do not answer 200, and no finding says so`);
      }
      if (l.bodyTextChars === 0 && route.findingCount === 0) {
        console.log(`${r.project} ${route.route}: a 200 page with no rendered text, reported as clean`);
      }
    }
  }

  fs.writeFileSync(path.join(out, 'survey-all.json'), JSON.stringify(all, null, 1), 'utf8');
  console.log(`\nwritten to ${out}\n`);
  process.exit(0);
}

if (require.main === module) {
  process.env.STACKI_NO_DIALOGS = '1';
  main().catch((err) => {
    console.error('the survey failed:', err?.stack || err);
    process.exit(1);
  });
}

module.exports = { independentLook, surveyOne };
