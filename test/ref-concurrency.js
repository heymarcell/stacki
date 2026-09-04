// A ref is a permission, and this is what it may not do.
//
//   node test/ref-concurrency.js
//
// Every check here is about ONE sentence: a write through a ref that no longer
// describes the document lands nowhere. Four separate ways it used to land
// anyway, each measured against the bytes on disk rather than against `ok`:
//
//   get_context and a comment focus handed out refs with no record of the
//   version they saw, so the guard that refuses a stale write had nothing to
//   compare and silently allowed everything.
//
//   a binding's `instanceRef` was worse than observationless — it had no
//   fingerprint either, so it was a bare index path. Insert an <hr> above the
//   <Hero> it named and the write landed on the <hr>, ok:true, no note.
//
//   an explicit expectedRevision REPLACED what the ref saw instead of adding
//   to it, so the same stale ref was refused with no arguments and accepted
//   with two. A guard a caller can switch off by naming a fresh number is not
//   a guard.
//
//   the style domain read the ref for its anchor and dropped both its
//   `writable` flag and its observation, so a ref the Visual Review evidence
//   rules had deliberately withheld write permission from wrote CSS to disk.
//
// The oracle throughout is the file. `ok:false` with the change on disk is the
// failure this suite exists to catch, so every refusal is paired with the bytes
// before and after, and every refusal is paired with a CONTROL that does the
// same thing with a fresh ref and proves it still works — a suite where
// everything is refused proves nothing at all.
//
// Non-Electron: test/agent-harness.js, the real main.js handlers and the real
// App.jsx in jsdom. Everything about SOURCE is exact here.

const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('./agent-harness.js');
const refs = require('../electron/mcp/agent/refs.js');
const { digestOf } = require('../electron/mcp/agent/digest.js');
const { anchorFrom } = require('../electron/review/anchor.js');

const failures = [];
let checked = 0;
const short = (x, n = 220) => JSON.stringify(x ?? null).slice(0, n);
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

/** What a ref actually carries. Nothing but a test may do this. */
const dec = (ref) => {
  const rest = String(ref).slice('stacki:'.length);
  return JSON.parse(Buffer.from(rest.slice(0, rest.lastIndexOf('.')), 'base64url').toString('utf8'));
};

// A paragraph longer than the 120-character preview cap in src/agent/targetRead.js,
// with two same-tag siblings after it — the pair of conditions that made a
// child ref unresolvable on the very next call.
const LONG =
  'This paragraph is deliberately long so that the child summary clip at one hundred and twenty characters bites into it and leaves an ellipsis behind.';

const PROSE_PAGE = `---
import Base from '../layouts/Base.astro';
import Hero from '../components/Hero.astro';
import site from '../data/site.json';
---
<Base>
  <Hero heading={site.tagline} />
  <div class="prose">
    <p>${LONG}</p>
    <p>Short one.</p>
    <p>Another short one.</p>
  </div>
  <section class="solo">
    <p>${LONG}</p>
  </section>
  <footer>
    <p>Made carefully.</p>
  </footer>
</Base>
`;

// A nav whose visible words ARE routes. Ordinary markup, and the shape that
// made the ref sanitiser delete a node's identity: every string in a ref
// payload was tested with path.isAbsolute() and "/docs" passes.
const ROUTE_PAGE = `---
import Base from '../layouts/Base.astro';
---
<Base>
  <nav class="routes">
    <a href="/docs">/docs</a>
    <a href="/blog">/blog</a>
  </nav>
  <p>ordinary words</p>
</Base>
`;

const projects = [];
const apps = [];
async function open(extra = {}) {
  const root = fs.realpathSync(H.makeProject(extra));
  const app = await H.start(root, { agentMode: 'full' });
  projects.push(root);
  apps.push(app);
  await H.settle(400);
  return { root, app, api: app.api, run: (d, a, args = {}) => app.api.run(d, a, args) };
}

(async () => {
  // ── 1 & 2. The two refs handed out without a read behind them ──────────────
  //
  // get_context's ref is minted from the payload the window publishes, and a
  // comment focus's ref is minted the same way — neither has an answer to take
  // a document observation from, which is exactly why both used to carry none.
  {
    const { root, app, api, run } = await open();

    const built = anchorFrom(app.payload());
    check('the payload describes something a ref can be made for', built.ok === true, built.reason || '');
    // electron/mcp/index.js selectionRef(), through the same function, so this
    // cannot drift from the caller it is about.
    const ctxRef = api.publishedNodeRef({ ...built.anchor, branch: app.payload().project?.branch || null }, { writable: true });
    check('get_context hands out a ref', typeof ctxRef === 'string' && ctxRef.startsWith('stacki:'));
    check('and it records the version it was made against', dec(ctxRef).o?.revision != null, short(dec(ctxRef).o));

    const read0 = await run('target', 'read');
    const footer = read0.target.children.find((c) => c.tag === 'footer');
    const moved = await run('target', 'add_class', { ref: footer.ref, className: 'moved-by-another-route' });
    check('the document can be moved by an independent route', moved.ok === true, short(moved));
    await H.settle(200);

    const bytesBefore = app.read('src/pages/index.astro');
    const stale = await run('target', 'add_class', { ref: ctxRef, className: 'through-stale-context-ref' });
    check('a write through the old get_context ref is refused', stale.ok === false && stale.code === 'stale_target', short(stale));
    check('and nothing reached the file', app.read('src/pages/index.astro') === bytesBefore);

    // CONTROL. The same call with a ref minted now must work, or the refusal
    // above is proving that get_context is broken rather than that it is safe.
    await H.settle(200);
    const builtNow = anchorFrom(app.payload());
    const freshCtxRef = api.publishedNodeRef({ ...builtNow.anchor, branch: app.payload().project?.branch || null }, { writable: true });
    const current = (await run('target', 'read')).document;
    check('a fresh get_context ref sees the current revision', dec(freshCtxRef).o?.revision === current.revision, `${short(dec(freshCtxRef).o)} vs ${short(current)}`);
    const ok1 = await run('target', 'add_class', { ref: freshCtxRef, className: 'through-fresh-context-ref' });
    check('and writing through it lands', ok1.ok === true, short(ok1));
    check('on disk', app.read('src/pages/index.astro').includes('through-fresh-context-ref'));

    // ── 2. the comment focus ref, with the ledger wired the way MCP wires it.
    // Required only now: electron/main.js has been loaded with the stubbed
    // `electron` by then, so this comes out of the same require cache and gets
    // the stub. Required at the top of the file it would find the real one and
    // have no ipcMain to register on.
    const reviews = require('../electron/review');
    const ledgerData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-refconc-reviews-'));
    reviews.start({ userDataPath: ledgerData, send: () => {} });
    reviews.openProject(root);
    reviews.attach({
      ask: app.ask,
      readPayload: app.payload,
      resolveTrail: app.resolveTrail,
      // electron/mcp/index.js's own mintRef, verbatim.
      mintRef: (anchor, opts) => api.publishedNodeRef(anchor, opts || {}) || null,
    });

    const page = await run('target', 'read');
    const hero = page.target.children.find((c) => c.tag === 'Hero');
    const inside = await run('target', 'enter', { ref: hero.ref });
    const h1 = inside.target.children.find((c) => c.tag === 'h1');
    await run('target', 'select', { ref: h1.ref });
    await H.settle(250);
    const made = reviews.act({ action: 'create', message: 'a comment to focus', authorType: 'human' });
    check('a comment can be left on the h1 inside <Hero>', made.ok === true, short(made));
    await run('target', 'exit');
    await H.settle(250);

    const listed = reviews.list({ status: 'open', scope: 'project', detail: 'summary', limit: 10 });
    const focused = await reviews.focus(listed.reviews[0].id);
    check('focusing it lands', focused.ok === true, short(focused));
    check('and the ref it hands back records a version', dec(focused.targetRef).o?.revision != null, short(dec(focused.targetRef).o));

    // Move Hero.astro by a second route — the focus ref's own parent.
    const viaFocus = await run('target', 'read', { ref: focused.targetRef });
    const heroSection = viaFocus.target.parent;
    const moved2 = await run('target', 'add_class', { ref: heroSection.ref, className: 'moved-hero-by-another-route' });
    check('Hero.astro can be moved by an independent route', moved2.ok === true, short(moved2));
    await H.settle(200);

    const heroBefore = app.read('src/components/Hero.astro');
    const staleFocus = await run('target', 'set_text', { ref: focused.targetRef, text: 'WRITTEN THROUGH A STALE FOCUS REF' });
    check('a write through the old focus ref is refused', staleFocus.ok === false && staleFocus.code === 'stale_target', short(staleFocus));
    check('and Hero.astro is byte-identical', app.read('src/components/Hero.astro') === heroBefore);

    // CONTROL: focus again and the fresh ref writes.
    await H.settle(200);
    const refocused = await reviews.focus(listed.reviews[0].id);
    const ok2 = await run('target', 'set_text', { ref: refocused.targetRef, text: 'WRITTEN THROUGH A FRESH FOCUS REF' });
    check('a fresh focus ref writes', ok2.ok === true, short(ok2));
    check('and the words are in Hero.astro', app.read('src/components/Hero.astro').includes('WRITTEN THROUGH A FRESH FOCUS REF'));

    reviews.closeProject?.();
    fs.rmSync(ledgerData, { recursive: true, force: true });
    app.stop();
  }

  // ── 3, 4, 5, 7, 8, 11. The consumption side ────────────────────────────────
  {
    const { root, app, api, run } = await open();

    // ── 3. a binding's instanceRef names a node in a document this read never
    // looked at. It is a pointer to go and read, not a handle to write through.
    // The page's own node, re-read through its ref each time. A read is not
    // observation-guarded — that is the documented way back from a stale ref —
    // so this stays a working handle on the page however far the tree moves.
    let rootRef = null;
    const page = async () => {
      const answer = rootRef ? await run('target', 'read', { ref: rootRef }) : await run('target', 'read');
      if (answer.ok) rootRef = answer.target.ref;
      return answer;
    };

    const pg = await page();
    const hero = pg.target.children.find((c) => c.tag === 'Hero');
    const inside = await run('target', 'enter', { ref: hero.ref });
    const p = inside.target.children.find((c) => c.tag === 'p');
    const readP = await run('target', 'read', { ref: p.ref });
    const binding = (readP.target.bindings || []).find((b) => b.source?.instanceRef);
    check('a prop binding names the instance that sets it', !!binding, short(readP.target.bindings));
    const instanceRef = binding.source.instanceRef;
    check('and that ref is not a write handle', dec(instanceRef).w === false, short(dec(instanceRef)));

    await run('target', 'exit');
    await H.settle(250);

    // CONTROL, taken FIRST while nothing has moved: reading through the
    // instance ref is the documented way to get a handle on the instance, and
    // the ref that read hands back does write to it.
    const viaInstance = await run('target', 'read', { ref: instanceRef });
    check('reading through the instance ref works', viaInstance.ok === true, short(viaInstance));
    check('and finds the component instance', viaInstance.ok && viaInstance.target.tag === 'Hero', short(viaInstance.ok ? viaInstance.target.tag : viaInstance));
    check('and inherits its caution', viaInstance.ok && dec(viaInstance.target.ref).w === false, short(dec(viaInstance.target.ref).w));
    const selectedInstance = await run('target', 'select', { ref: instanceRef });
    check('selecting through it puts the instance in front of the person', selectedInstance.ok === true, short(selectedInstance));
    check('and hands back a ref that records a version', dec(selectedInstance.ref).o?.revision != null, short(dec(selectedInstance.ref).o));
    check('and the marks the instance ref carried', dec(selectedInstance.ref).d?.fingerprint?.tag === 'Hero', short(dec(selectedInstance.ref).d?.fingerprint));
    const onHero = await run('target', 'set_prop', { ref: selectedInstance.ref, name: 'data-probe', value: 'on-the-hero' });
    check('and that ref writes', onHero.ok === true, short(onHero));
    check('to the <Hero>', /<Hero[^>]*data-probe="on-the-hero"/.test(app.read('src/pages/index.astro')), app.read('src/pages/index.astro'));

    await H.settle(250);
    const pg2 = await page();
    const heroNow = pg2.target.children.find((c) => c.tag === 'Hero');
    const inserted = await run('target', 'insert_before', { ref: heroNow.ref, node: { kind: 'element', tag: 'hr' } });
    check('an <hr> can be inserted above the <Hero>', inserted.ok === true, short(inserted));
    await H.settle(250);
    check('and it is in the file', /<hr\s*\/?>/.test(app.read('src/pages/index.astro')), app.read('src/pages/index.astro'));

    const beforeInstanceWrite = app.read('src/pages/index.astro');
    const wrongNode = await run('target', 'set_prop', { ref: instanceRef, name: 'data-probe', value: 'landed-here' });
    check('a write through the instance ref is refused', wrongNode.ok === false && wrongNode.code === 'not_editable', short(wrongNode));
    check('and nothing landed on the node that took its place', !/<hr[^>]*data-probe/.test(app.read('src/pages/index.astro')), app.read('src/pages/index.astro'));
    check('and the page is byte-identical', app.read('src/pages/index.astro') === beforeInstanceWrite);

    // And the read through it does not quietly answer with whatever now stands
    // at that index. It may find the <Hero> where it moved to, or say it cannot
    // — it may not come back holding the <hr>.
    const afterInsert = await run('target', 'read', { ref: instanceRef });
    check('and a read through it never comes back as the <hr>', afterInsert.ok === false || afterInsert.target.tag === 'Hero', short(afterInsert.ok ? afterInsert.target.tag : afterInsert.code));

    // ── 4. a client-supplied expectation may add a constraint; it may not
    // replace what the ref saw.
    await H.settle(200);
    const read1 = await page();
    const footer = read1.target.children.find((c) => c.tag === 'footer');
    const otherKid = read1.target.children.find((c) => c.tag === 'div');
    const bump = await run('target', 'add_class', { ref: otherKid.ref, className: 'bumped-the-revision' });
    check('the document moved under the footer ref', bump.ok === true, short(bump));
    await H.settle(200);
    const fresh = await page();
    check('and the read after it sees a later revision', fresh.document.revision > read1.document.revision, `${read1.document.revision} -> ${fresh.document.revision}`);

    const beforeLaunder = app.read('src/pages/index.astro');
    const laundered = await run('target', 'add_class', {
      ref: footer.ref,
      className: 'laundered',
      expectedRevision: fresh.document.revision,
      expectedDigest: fresh.document.digest,
    });
    check('a fresh expectation cannot launder a stale ref', laundered.ok === false, short(laundered));
    check('and is told which of the two versions it disagreed with', laundered.code === 'bad_request' || laundered.code === 'stale_target', short(laundered.code));
    check('and nothing was written', app.read('src/pages/index.astro') === beforeLaunder);

    // CONTROL: the same two arguments on a ref that agrees with them.
    const footerNow = fresh.target.children.find((c) => c.tag === 'footer');
    const agreed = await run('target', 'add_class', {
      ref: footerNow.ref,
      className: 'named-what-it-saw',
      expectedRevision: fresh.document.revision,
      expectedDigest: fresh.document.digest,
    });
    check('naming the version the ref also saw is still allowed', agreed.ok === true, short(agreed));
    check('and it lands', app.read('src/pages/index.astro').includes('named-what-it-saw'));

    // RECOVERY, which is the other half of every refusal above. A stale ref is
    // still a perfectly good READ handle — reads are not observation-guarded on
    // purpose — so getting back from `stale_target` is one call per ref and
    // never a re-discovery. If this ever stops being true the refusals become
    // dead ends, so it is pinned here rather than left as a property nobody
    // checks.
    const recovered = await run('target', 'read', { ref: footer.ref });
    check('a stale ref still reads', recovered.ok === true, short(recovered));
    check('and re-resolves to the node it named', recovered.ok && recovered.target.tag === 'footer', short(recovered.ok ? recovered.target.tag : null));
    check('and the ref that read hands back sees the current revision', dec(recovered.target.ref).o?.revision === recovered.document.revision, `${short(dec(recovered.target.ref).o)} vs ${short(recovered.document)}`);
    const afterRecovery = await run('target', 'add_class', { ref: recovered.target.ref, className: 'recovered' });
    check('so one read is the whole of getting back from stale_target', afterRecovery.ok === true, short(afterRecovery));
    check('and it lands on the footer', /<footer class="[^"]*recovered/.test(app.read('src/pages/index.astro')), app.read('src/pages/index.astro'));

    // ── 5. the style domain honours a ref's writable flag and its observation.
    await H.settle(200);
    const pg3 = await page();
    const grid = pg3.target.children.find((c) => c.tag === 'div');
    await run('target', 'select', { ref: grid.ref });
    await H.settle(250);
    const styles = await run('style', 'read', {});
    const rule = (styles.rules || []).find((r) => r.selector === '.pricing-grid');
    check('the grid has an authored rule to write into', !!rule, short((styles.rules || []).map((r) => r.selector)));
    const identity = rule.declarations[0].identity;

    const readOnly = api.nodeRef(dec(grid.ref).d, { writable: false, observed: dec(grid.ref).o });
    const cssBefore = app.read('src/styles/site.css');
    const cssRefused = await run('style', 'set_property', { ref: readOnly, identity, property: 'gap', value: '4rem' });
    check('a read-only ref cannot write CSS either', cssRefused.ok === false && cssRefused.code === 'not_editable', short(cssRefused));
    check('and the stylesheet is byte-identical', app.read('src/styles/site.css') === cssBefore);

    // CONTROL: the same write through the writable ref the read handed over.
    const cssOk = await run('style', 'set_property', { ref: grid.ref, identity, property: 'gap', value: '4rem' });
    check('the writable ref writes the same declaration', cssOk.ok === true, short(cssOk));
    check('and the stylesheet moved', app.read('src/styles/site.css') !== cssBefore && /gap:\s*4rem/.test(app.read('src/styles/site.css')));

    // ── 7. the refs that are observationless BY DESIGN stay usable.
    const stillReads = await run('target', 'read', { ref: readOnly });
    check('a read-only ref is still a perfectly good read handle', stillReads.ok === true, short(stillReads));

    const newFile = 'src/styles/not-written-yet.css';
    const newRef = api.sourceRef(newFile);
    const parsedNew = refs.parse(newRef, { projectRoot: root });
    check('a source ref for a file that does not exist yet carries no observation', parsedNew.ok && parsedNew.observed === null, short(parsedNew.observed));
    check('and is still writable — there is no version for it to be stale against', parsedNew.writable === true);
    const created = await run('source', 'write', { ref: newRef, path: newFile, text: '.later {}\n' });
    check('and a write through it creates the file', created.ok === true, short(created));
    check('with the bytes it was given', app.exists(newFile) && app.read(newFile) === '.later {}\n');

    const withVars = (await run('style', 'read', {})).rules || [];
    const varRef = withVars.flatMap((r) => (r.declarations || []).flatMap((d) => d.variableRefs || []))[0];
    if (varRef) {
      const parsedVar = refs.parse(varRef, { projectRoot: root });
      check('a cssvar ref names a variable and nothing writable', parsedVar.ok && parsedVar.kind === 'cssvar' && parsedVar.writable === false, short(parsedVar));
    }

    // ── 8. and a writable node ref for a node that DOES exist, with the
    // observation taken off, fails closed. Minted straight through refs.mint,
    // which is the only way to build one now — that is the point.
    const read2 = await page();
    const victim = read2.target.children.find((c) => c.tag === 'footer');
    const stripped = refs.mint('node', dec(victim.ref).d, { projectRoot: root, writable: true, observed: null });
    const beforeStripped = app.read('src/pages/index.astro');
    const closed = await run('target', 'add_class', { ref: stripped, className: 'through-an-unobserved-ref' });
    check('a writable node ref with no observation is refused', closed.ok === false, short(closed));
    check('with a code an agent can act on', closed.code === 'bad_ref' || closed.code === 'stale_ref', short(closed.code));
    check('and nothing was written', app.read('src/pages/index.astro') === beforeStripped);
    const cssNow = app.read('src/styles/site.css');
    const closedStyle = await run('style', 'set_property', { ref: stripped, identity, property: 'gap', value: '9rem' });
    check('and the style domain refuses it too', closedStyle.ok === false, short(closedStyle));
    check('leaving the stylesheet alone', app.read('src/styles/site.css') === cssNow);

    // ── 11. nothing in a ref is a filesystem path.
    // Every string in a decoded ref that names a place on this machine. The
    // page ROUTE is deliberately exempt: "/" is the site's address, not a
    // filesystem path, and it is the one absolute-looking thing a ref may
    // legitimately carry.
    const absolutes = (payload) => {
      const out = [];
      const walk = (v, key) => {
        if (typeof v === 'string') {
          if (key === 'route') return;
          if (path.isAbsolute(v) || v.includes(root)) out.push(v);
          return;
        }
        if (Array.isArray(v)) return v.forEach((item) => walk(item, key));
        if (v && typeof v === 'object') return Object.entries(v).forEach(([k, item]) => walk(item, k));
      };
      walk(payload, null);
      return out;
    };
    const read3 = await page();
    check('a read ref names no filesystem path', absolutes(dec(read3.target.ref)).length === 0, short(absolutes(dec(read3.target.ref))));
    const selected = await run('target', 'select', { ref: read3.target.children[0].ref });
    check('nor does a select ref', absolutes(dec(selected.ref)).length === 0, short(absolutes(dec(selected.ref))));
    await H.settle(150);
    const live = await run('target', 'add_class', { className: 'from-the-live-selection' });
    check('nor does the ref a write on the live selection hands back', live.ok === true && absolutes(dec(live.ref)).length === 0, short(live.ok ? absolutes(dec(live.ref)) : live));
    check('and the document a ref observed is named relatively', dec(live.ref).o?.file === 'src/pages/index.astro', short(dec(live.ref).o));

    app.stop();
  }

  // ── 9, 12. Resolution, and what a failure to resolve says ──────────────────
  {
    const { app, run } = await open({ 'src/pages/index.astro': PROSE_PAGE });

    const page = await run('target', 'read');
    const div = page.target.children.find((c) => c.tag === 'div');
    const readDiv = await run('target', 'read', { ref: div.ref });
    const kids = readDiv.target.children;
    check('the prose block has three same-tag children', kids.length === 3 && kids.every((k) => k.tag === 'p'), short(kids.map((k) => k.tag)));
    check('and the first one is longer than the preview cap', String(kids[0].text).endsWith('…'), short(kids[0].text));

    // The two halves of what makes that ref resolvable, named separately —
    // either one on its own is enough to find the node again, so the behaviour
    // below stays green if only one of them is reverted. Together they identify
    // the NODE; the slot alone is what a sibling inserted above it takes over.
    const kidFingerprint = dec(kids[0].ref).d.fingerprint;
    check('its ref records no words rather than a preview of them', kidFingerprint.text === null, short(kidFingerprint.text));
    check('and records the sibling run at every level instead', Array.isArray(kidFingerprint.peers) && kidFingerprint.peers.length > 0, short(kidFingerprint.peers));
    check('while a child whose words fit still records them', dec(kids[1].ref).d.fingerprint.text === 'Short one.', short(dec(kids[1].ref).d.fingerprint.text));

    const first = await run('target', 'read', { ref: kids[0].ref });
    check('a child ref for a long paragraph resolves', first.ok === true, short(first));
    check('and its own words come back whole', first.ok && first.target.text.value.startsWith(LONG.slice(0, 60)), short(first.ok ? first.target.text.value : null));
    // The right node, proved on disk rather than on the answer: the class has
    // to land on the LONG paragraph and on neither of its neighbours.
    const landed = await run('target', 'add_class', { ref: kids[0].ref, className: 'the-long-one' });
    check('and a write through it lands', landed.ok === true, short(landed));
    const prose = app.read('src/pages/index.astro');
    check('on the paragraph that ref named', new RegExp(`<p class="the-long-one">${LONG.slice(0, 30)}`).test(prose), prose.split('\n').slice(5, 10).join('\n'));
    check('and on nothing else', (prose.match(/the-long-one/g) || []).length === 1);

    // CONTROLS: the two short siblings, and the lone long paragraph that never
    // had a same-tag sibling to be confused with.
    const second = await run('target', 'read', { ref: kids[1].ref });
    check('the short sibling resolves too', second.ok === true && second.target.text.value === 'Short one.', short(second.ok ? second.target.text.value : second));
    const third = await run('target', 'read', { ref: kids[2].ref });
    check('and the third', third.ok === true && third.target.text.value === 'Another short one.', short(third.ok ? third.target.text.value : third));
    const solo = page.target.children.find((c) => c.tag === 'section');
    const readSolo = await run('target', 'read', { ref: solo.ref });
    const lone = await run('target', 'read', { ref: readSolo.target.children[0].ref });
    check('and a long paragraph with no same-tag sibling still does', lone.ok === true, short(lone));

    // ── 12. a target-domain failure speaks target-domain English and carries
    // the reason as data. Built by deleting the node the ref names.
    const doomed = readSolo.target.children[0].ref;
    await run('target', 'remove', { ref: readSolo.target.children[0].ref });
    await H.settle(250);
    const dead = await run('target', 'read', { ref: doomed });
    check('a ref to a node that is gone fails', dead.ok === false, short(dead));
    check('and is not worded as a review', !/review|creationContext/i.test(String(dead.message)), dead.message);
    check('and names the file the ref pointed into', String(dead.message).includes('src/pages/index.astro'), dead.message);
    check('and hands back the reason as data', typeof dead.reason === 'string' && dead.reason.length > 0, short(dead.reason));
    check('and does not claim to have restored a component it never walked', dead.restored == null || dead.restored.component === false, short(dead.restored));
    check('nor to have restored a page that was already open', dead.restored == null || dead.restored.page === false, short(dead.restored));

    app.stop();
  }

  // ── 10. What an undo says it put back ──────────────────────────────────────
  {
    const { app, run } = await open();

    const cssBefore = app.read('src/styles/site.css');
    const pageBefore = app.read('src/pages/index.astro');
    const cssDigestBefore = digestOf(cssBefore);

    const wrote = await run('style', 'write_source', { path: 'src/styles/site.css', css: `${cssBefore}\n.added-by-a-test { color: red; }\n`, expectedDigest: cssDigestBefore });
    check('a stylesheet can be rewritten', wrote.ok === true, short(wrote));
    await H.settle(250);
    check('and the bytes moved', app.read('src/styles/site.css') !== cssBefore);

    const undone = await run('project', 'undo');
    await H.settle(300);
    check('undoing it reports it undone', undone.ok === true && undone.undone === true, short(undone));
    check('and names the stylesheet it put back', (undone.restored?.files || []).map((f) => f.file).includes('src/styles/site.css'), short(undone.restored));
    check('and not the page the editor happens to have open', !(undone.restored?.files || []).map((f) => f.file).includes('src/pages/index.astro'), short(undone.restored));
    check('the stylesheet is back byte for byte', app.read('src/styles/site.css') === cssBefore);
    check('and the undo says so with a content digest', (undone.restored?.files || [])[0]?.contentDigest === cssDigestBefore, short(undone.restored));

    // The two digests are different KINDS, and the response has to let a client
    // tell them apart. The model digest is an identity for the parse the editor
    // is holding; the content digest is sha256 of bytes.
    check('the document reports a model digest under its own name', typeof undone.document?.modelDigest === 'string', short(undone.document));
    check('which is not the content digest of anything it named', undone.document.modelDigest !== (undone.restored?.files || [])[0]?.contentDigest, short(undone.document));
    check('and the open page it names is unchanged on disk', app.read('src/pages/index.astro') === pageBefore);

    // Consecutive undo with nothing left to undo is honest about it.
    const historyBefore = undone.history;
    const again = await run('project', 'undo');
    await H.settle(250);
    if (historyBefore.past === 0) {
      check('a second undo with an empty stack undoes nothing', again.undone === false, short(again));
      check('and names nothing as restored', again.restored === null, short(again.restored));
      check('and reports the same document it reported before', again.document.revision === undone.document.revision && again.document.modelDigest === undone.document.modelDigest, `${short(undone.document)} vs ${short(again.document)}`);
    }

    // A page change names the page.
    await H.settle(200);
    const read = await run('target', 'read');
    const footer = read.target.children.find((c) => c.tag === 'footer');
    const edited = await run('target', 'add_class', { ref: footer.ref, className: 'about-to-be-undone' });
    check('a page edit lands', edited.ok === true, short(edited));
    await H.settle(250);
    const undoPage = await run('project', 'undo');
    await H.settle(300);
    check('undoing it names the page', (undoPage.restored?.files || []).map((f) => f.file).includes('src/pages/index.astro'), short(undoPage.restored));
    check('and the class is gone from the file', !app.read('src/pages/index.astro').includes('about-to-be-undone'));

    // THE THIRD WAY A STYLESHEET GETS WRITTEN, and the one the answer was blind
    // to. `style.write_source` above goes through the main process, which
    // records its own undo entry and derives the file list from the bytes it is
    // holding. `style.set_property` does not: it goes through the style panel's
    // own writer, which records the inverse and nothing else — so the entry
    // that came off the stack had no files on it and `project.undo` answered
    // `restored: {kind:'cmd', files: []}` beside a `document` naming the open
    // page. Bytes exactly right, three times running, evidence pointing at a
    // file that had not been touched. Measured by a real Claude Code against a
    // packaged build; the section above passed throughout, because it never
    // exercised this writer.
    //
    // Both kinds are checked here on purpose, and each is checked for the
    // OTHER'S file as well: an answer that named every file it could think of
    // would be as useless as one that named none.
    await H.settle(200);
    {
      const page = await run('target', 'read');
      const grid = page.target.children.find((c) => c.label === 'pricing-grid');
      // Taken now, off the same read. A style write SELECTS what it wrote for,
      // so a later `target.read` with no ref answers about the grid rather than
      // about the page — and the page has not moved, which is what makes a ref
      // minted here still good after the undo.
      const hero = page.target.children.find((c) => c.tag === 'Hero');
      const styles = await run('style', 'read', { ref: grid.ref });
      const rule = (styles.rules || []).find((r) => r.selector === '.pricing-grid');
      const gap = rule?.declarations.find((d) => d.property === 'gap');
      check('the declaration to write through is there', !!gap, short(styles.rules?.map((r) => r.selector)));

      const cssWas = app.read('src/styles/site.css');
      const pageWas = app.read('src/pages/index.astro');
      const cssDigestWas = digestOf(cssWas);
      const set = await run('style', 'set_property', { ref: grid.ref, identity: gap.identity, property: 'gap', value: '4.25rem' });
      check('a property written through the panel’s own writer lands', set.ok === true, short(set));
      await H.settle(300);
      check('and the stylesheet really moved', app.read('src/styles/site.css').includes('4.25rem'), short(app.read('src/styles/site.css').slice(0, 120)));

      const undone = await run('project', 'undo');
      await H.settle(400);
      const named = (undone.restored?.files || []).map((f) => f.file);
      check('undoing it puts the stylesheet back byte for byte', app.read('src/styles/site.css') === cssWas, short(app.read('src/styles/site.css').slice(0, 160)));
      check('  and the answer names the stylesheet, not the open page', named.includes('src/styles/site.css'), short(undone.restored));
      check('  and does not name the page it did not touch', !named.includes('src/pages/index.astro'), short(undone.restored));
      check('  which the open page on disk agrees with', app.read('src/pages/index.astro') === pageWas);
      const restoredCss = (undone.restored?.files || []).find((f) => f.file === 'src/styles/site.css');
      check('  with the content digest of what is on disk now', restoredCss?.contentDigest === cssDigestWas, short({ said: restoredCss, real: cssDigestWas }));
      check('  and the digest of what it replaced, which is not the same', typeof restoredCss?.beforeDigest === 'string' && restoredCss.beforeDigest !== cssDigestWas, short(restoredCss));

      // The model kind, immediately afterwards and on the same stack, so the
      // two are told apart by what they name rather than by which test ran.
      const edited = await run('target', 'add_class', { ref: hero.ref, className: 'undo-kind-control' });
      check('a page edit lands too', edited.ok === true, short(edited));
      await H.settle(250);
      const undonePage = await run('project', 'undo');
      await H.settle(350);
      const namedPage = (undonePage.restored?.files || []).map((f) => f.file);
      check('undoing THAT names the page', namedPage.includes('src/pages/index.astro'), short(undonePage.restored));
      check('  and not the stylesheet it never touched', !namedPage.includes('src/styles/site.css'), short(undonePage.restored));
      check('  and the class is gone from the file', !app.read('src/pages/index.astro').includes('undo-kind-control'));

      // Put the selection back where this block found it. A style write selects
      // what it wrote for, and the checks after this one read the LIVE
      // selection rather than naming a ref — leaving the grid selected would
      // make them ask about the wrong element.
      await run('target', 'select', { ref: page.target.ref });
      await H.settle(200);
    }

    // A rename is two paths, and an undo of one has to name both.
    await H.settle(200);
    const renamed = await run('asset', 'rename', { path: 'public/robots.txt', name: 'robots-renamed.txt' });
    check('an asset can be renamed', renamed.ok === true, short(renamed));
    await H.settle(250);
    const undoRename = await run('project', 'undo');
    await H.settle(300);
    const named = (undoRename.restored?.files || []).map((f) => f.file);
    check('undoing a rename names both paths it touched', named.includes('public/robots.txt') && named.includes('public/robots-renamed.txt'), short(undoRename.restored));
    check('and the file is back under its old name', app.exists('public/robots.txt') && !app.exists('public/robots-renamed.txt'));

    // And a ref minted before an unrelated stylesheet edit is still good after
    // its undo — the open page never moved, so nothing about it is stale.
    await H.settle(250);
    const held = await run('target', 'read');
    const heldFooter = held.target.children.find((c) => c.tag === 'footer');
    const pageBytes = app.read('src/pages/index.astro');
    await run('style', 'write_source', { path: 'src/styles/site.css', css: `${app.read('src/styles/site.css')}\n.again {}\n`, expectedDigest: digestOf(app.read('src/styles/site.css')) });
    await H.settle(250);
    await run('project', 'undo');
    await H.settle(300);
    check('an unrelated stylesheet undo leaves the open page byte-identical', app.read('src/pages/index.astro') === pageBytes);
    const stillGood = await run('target', 'add_class', { ref: heldFooter.ref, className: 'still-valid' });
    check('so a ref taken before it still writes', stillGood.ok === true, short(stillGood));

    app.stop();
  }

  // ── 13. Every argument position a ref arrives in, not the one called `ref` ──
  //
  // The guard was built for the target of a write and the surface has more ref
  // arguments than that. A move carries TWO writable refs on one call — the
  // node, and the parent it lands in — and the destination was read for its
  // `keys` and nothing else: no permission, no observation, no marks. Both
  // halves of that were measured before this section existed.
  //
  //   a parentRef minted before an <aside> was inserted above the div it named
  //   moved a <footer> into the <aside> instead. ok:true, no note, no code.
  //
  //   a ref the evidence rules had deliberately withheld write permission from
  //   was accepted as a parent, and the markup landed inside it.
  //
  // The companion to this is in test/agent-api.js, which enumerates every
  // ref-typed argument off the wire so a new one cannot be added without
  // somebody deciding what guards it. This is the behaviour half: the refusal,
  // and the bytes.
  {
    const { root, app, api, run } = await open();
    const FILE = 'src/pages/index.astro';

    let rootRef = null;
    const page = async () => {
      const answer = rootRef ? await run('target', 'read', { ref: rootRef }) : await run('target', 'read');
      if (answer.ok) rootRef = answer.target.ref;
      return answer;
    };

    // ── 13a. a STALE destination.
    const pg = await page();
    const grid = pg.target.children.find((c) => c.tag === 'div');
    const staleParent = grid.ref;
    const inserted = await run('target', 'insert_before', { ref: grid.ref, node: { kind: 'element', tag: 'aside' } });
    check('a sibling can be inserted above the move destination', inserted.ok === true, short(inserted));
    await H.settle(250);
    const shifted = await page();
    check('and the destination is one slot further down than its ref says', shifted.target.children.map((c) => c.tag).join(',') === 'Hero,aside,div,footer', short(shifted.target.children.map((c) => c.tag)));

    const footerNow = shifted.target.children.find((c) => c.tag === 'footer');
    const beforeStale = app.read(FILE);
    const intoStale = await run('target', 'move', { ref: footerNow.ref, to: { parentRef: staleParent, index: 0 } });
    check('a move into a stale destination is refused', intoStale.ok === false, short(intoStale));
    check('and says the version is what disagreed', intoStale.code === 'stale_target', short(intoStale.code));
    check('and the page is byte-identical', app.read(FILE) === beforeStale);
    check('and nothing went into the <aside> that took the slot', /<aside><\/aside>|<aside\s*\/>/.test(app.read(FILE)), app.read(FILE));

    // CONTROL: the same move, with a destination read at the same moment as the
    // node being moved. A section where every move is refused proves nothing.
    const freshParent = shifted.target.children.find((c) => c.tag === 'div');
    const intoFresh = await run('target', 'move', { ref: footerNow.ref, to: { parentRef: freshParent.ref, index: 0 } });
    check('a move into a destination read at the same moment lands', intoFresh.ok === true, short(intoFresh));
    await H.settle(250);
    check('and the footer really is inside the grid on disk', /<div class="pricing-grid">[\s\S]{0,20}<footer>/.test(app.read(FILE)), app.read(FILE));

    // ── 13b. a READ-ONLY destination. Minted through the same api.nodeRef the
    // product uses, from the marks and the observation of a ref that works.
    await H.settle(200);
    const pg2 = await page();
    const gridNow = pg2.target.children.find((c) => c.tag === 'div');
    const heroNow = pg2.target.children.find((c) => c.tag === 'Hero');
    const readOnlyParent = api.nodeRef(dec(gridNow.ref).d, { writable: false, observed: dec(gridNow.ref).o });
    check('a read-only destination ref can be made from a working one', dec(readOnlyParent).w === false, short(dec(readOnlyParent).w));
    const beforeReadOnly = app.read(FILE);
    const intoReadOnly = await run('target', 'move', { ref: heroNow.ref, to: { parentRef: readOnlyParent, index: 0 } });
    check('a move INTO a read-only ref is refused', intoReadOnly.ok === false, short(intoReadOnly));
    check('for the reason it is refused as a target', intoReadOnly.code === 'not_editable', short(intoReadOnly.code));
    check('and the page is byte-identical', app.read(FILE) === beforeReadOnly);

    // ── 13c. a destination with NO OBSERVATION. Writable and unguardable is the
    // same failure the target side fails closed on.
    const unobservedParent = refs.mint('node', dec(gridNow.ref).d, { projectRoot: root, writable: true, observed: null });
    const intoUnobserved = await run('target', 'move', { ref: heroNow.ref, to: { parentRef: unobservedParent, index: 0 } });
    check('a move into a destination with no record of what it saw is refused', intoUnobserved.ok === false, short(intoUnobserved));
    check('with a code an agent can act on', intoUnobserved.code === 'bad_ref' || intoUnobserved.code === 'stale_ref', short(intoUnobserved.code));
    check('and nothing moved', app.read(FILE) === beforeReadOnly);

    // CONTROL for both: the writable, observed twin of that same destination.
    const intoWritable = await run('target', 'move', { ref: heroNow.ref, to: { parentRef: gridNow.ref, index: 0 } });
    check('the writable twin of that destination takes the node', intoWritable.ok === true, short(intoWritable));
    await H.settle(250);
    check('and the <Hero> is in the grid on disk', /<div class="pricing-grid">[\s\S]{0,20}<Hero/.test(app.read(FILE)), app.read(FILE));

    app.stop();
  }

  // ── 13d. The same ref, in the same position, inside an edit BATCH ──────────
  //
  // `target.move` and `target.edit [{type:'move'}]` are two call shapes into one
  // normalizer. Proving the guard on one of them is not proving it on the other,
  // and a batch is the shape an agent reaches for when it is doing several
  // things at once — which is when it is least likely to have re-read.
  {
    const { app, api, run } = await open();
    const FILE = 'src/pages/index.astro';

    let rootRef = null;
    const page = async () => {
      const answer = rootRef ? await run('target', 'read', { ref: rootRef }) : await run('target', 'read');
      if (answer.ok) rootRef = answer.target.ref;
      return answer;
    };

    const pg = await page();
    const grid = pg.target.children.find((c) => c.tag === 'div');
    const staleParent = grid.ref;
    const readOnlyParent = api.nodeRef(dec(grid.ref).d, { writable: false, observed: dec(grid.ref).o });
    await run('target', 'insert_before', { ref: grid.ref, node: { kind: 'element', tag: 'hr' } });
    await H.settle(250);
    const beforeBatch = app.read(FILE);
    check('the destination ref is a slot behind the document now', /<hr\s*\/?>[\s\S]{0,20}<div class="pricing-grid">/.test(beforeBatch), beforeBatch);

    const shifted = await page();
    const footer = shifted.target.children.find((c) => c.tag === 'footer');
    const batchStale = await run('target', 'edit', {
      ref: footer.ref,
      operations: [{ type: 'move', to: { parentRef: staleParent, index: 0 } }],
    });
    check('a stale destination inside an edit batch is refused too', batchStale.ok === false, short(batchStale));
    check('and says the version is what disagreed', batchStale.code === 'stale_target', short(batchStale.code));
    check('and the page is byte-identical', app.read(FILE) === beforeBatch);

    const batchReadOnly = await run('target', 'edit', {
      ref: footer.ref,
      operations: [{ type: 'move', to: { parentRef: readOnlyParent, index: 0 } }],
    });
    check('and so is a read-only one', batchReadOnly.ok === false && batchReadOnly.code === 'not_editable', short(batchReadOnly));
    check('with the page still byte-identical', app.read(FILE) === beforeBatch);

    // CONTROL: the batch shape does move a node when the destination is current.
    const gridNow = shifted.target.children.find((c) => c.tag === 'div');
    const batchOk = await run('target', 'edit', {
      ref: footer.ref,
      operations: [{ type: 'move', to: { parentRef: gridNow.ref, index: 0 } }],
    });
    check('an edit batch moves a node when the destination is current', batchOk.ok === true, short(batchOk));
    await H.settle(250);
    check('and the footer is inside the grid on disk', /<div class="pricing-grid">[\s\S]{0,20}<footer>/.test(app.read(FILE)), app.read(FILE));

    // ── 13e. a destination only the RENDERER can disqualify.
    //
    // This ref is writable and its observation agrees with the document exactly,
    // so every check the main process is able to make passes. What is wrong with
    // it is that the tree it was made for is not the tree that is open, and the
    // renderer is the only party holding a tree — it re-finds the parent by its
    // marks, gets there on position alone, and applies the same evidence rule a
    // pin is drawn under. Without that second half the guard is only as good as
    // what a signed payload can be asked about itself.
    await H.settle(200);
    const settled = await page();
    const gridFinal = settled.target.children.find((c) => c.tag === 'div');
    const heroFinal = settled.target.children.find((c) => c.tag === 'Hero');
    const gridMarks = dec(gridFinal.ref);
    const otherTree = api.nodeRef(
      { ...gridMarks.d, branch: 'feature/elsewhere', fingerprint: { ...gridMarks.d.fingerprint, text: 'WORDS THAT ARE NOT IN THIS TREE' } },
      { writable: true, observed: gridMarks.o }
    );
    check('that destination ref is writable', dec(otherTree).w !== false, short(dec(otherTree).w));
    check('and names the version the document is on', dec(otherTree).o?.revision === settled.document.revision, `${short(dec(otherTree).o)} vs ${short(settled.document)}`);
    const beforeOther = app.read(FILE);
    const intoOtherTree = await run('target', 'move', { ref: heroFinal.ref, to: { parentRef: otherTree, index: 0 } });
    check('and a move into it is refused anyway', intoOtherTree.ok === false, short(intoOtherTree));
    check('because the renderer could only place it by position', intoOtherTree.code === 'not_editable', short(intoOtherTree.code));
    check('with the page byte-identical', app.read(FILE) === beforeOther);

    // ── 13f. a destination in ANOTHER FILE. An ordinary, current, writable node
    // ref — for a node inside a component's own markup. It has to be told apart
    // from a stale one, because "read the destination again" is the wrong
    // instruction: reading again will not make a node in one file a place in
    // another.
    const heroFileBefore = app.read('src/components/Hero.astro');
    const afterRefusals = await page();
    const heroStill = (afterRefusals.target.children || []).find((c) => c.tag === 'Hero');
    check('every refusal above left the <Hero> where it was', !!heroStill, short((afterRefusals.target.children || []).map((c) => c.tag)));
    const openedHero = heroStill ? await run('target', 'enter', { ref: heroStill.ref }) : { ok: false };
    check('the component can be opened', openedHero.ok === true, short(openedHero));
    const insideHero = openedHero.ok ? openedHero.target.ref : null;
    check('and its root is an ordinary writable ref', !!insideHero && dec(insideHero).w !== false && dec(insideHero).o?.file === 'src/components/Hero.astro', short(insideHero && dec(insideHero)));
    await run('target', 'exit');
    await H.settle(250);

    const back = await page();
    const beforeCross = app.read(FILE);
    const cross = insideHero
      ? await run('target', 'move', { ref: back.target.children[0].ref, to: { parentRef: insideHero, index: 0 } })
      : { ok: true, code: 'never got a ref inside the component' };
    check('a destination in another file is refused', cross.ok === false, short(cross));
    check('and named as the wrong target rather than a version disagreement', cross.code === 'wrong_target', short(cross.code));
    check('and the page is byte-identical', app.read(FILE) === beforeCross);
    check('and so is the component file', app.read('src/components/Hero.astro') === heroFileBefore);

    app.stop();
  }

  // ── 14. A ref may only ever become MORE restrictive as it travels ──────────
  //
  // index.js states that rule and two calls broke it in the same way. `select`
  // was fixed to carry the renderer's own judgement out — and nothing measured
  // it, so deleting that fix flipped a refusal into a landed write with every
  // suite green. `enter` is the identical code path with the identical
  // omission and was not fixed: pass a ref Stacki has just refused a write
  // through, enter, and what came back was a working write handle for the root
  // of whatever component now occupies that slot.
  //
  // The ref here is built the way the product builds a read-only one — a node
  // recovered on position alone, on a tree the ref was not made for — rather
  // than by asking for `writable: false`, so what is measured is the evidence
  // rule and not a flag.
  {
    const { app, api, run } = await open();
    const FILE = 'src/pages/index.astro';
    const HERO = 'src/components/Hero.astro';

    const pg = await run('target', 'read');
    const hero = pg.target.children.find((c) => c.tag === 'Hero');
    const marks = dec(hero.ref);
    const divergent = api.nodeRef(
      { ...marks.d, branch: 'feature/elsewhere', fingerprint: { ...marks.d.fingerprint, text: 'WORDS THAT ARE NOT IN THIS TREE' } },
      { writable: true, observed: marks.o }
    );
    check('the ref this starts from was minted writable', dec(divergent).w !== false, short(dec(divergent).w));

    const read = await run('target', 'read', { ref: divergent });
    check('a ref from another branch still reads', read.ok === true, short(read));
    check('and Stacki says it got there on position alone', read.target.confidence === 'positional', short(read.target.confidence));
    check('and that it will not write through that', read.target.editable === false, short(read.target.editable));
    check('so the ref the read hands back is not a write handle', dec(read.target.ref).w === false, short(dec(read.target.ref).w));

    const pageBefore = app.read(FILE);
    const direct = await run('target', 'set_prop', { ref: divergent, name: 'data-direct', value: '1' });
    check('a write through it is refused', direct.ok === false && direct.code === 'not_editable', short(direct));
    check('and the page is byte-identical', app.read(FILE) === pageBefore);

    // SELECT. The refusal above is the whole point of the fix below: selecting
    // re-resolves the node and re-derives the same evidence rule, so it may
    // only ever hand back the same judgement or a narrower one.
    const selected = await run('target', 'select', { ref: divergent });
    check('selecting through it puts the node in front of the person', selected.ok === true, short(selected));
    check('and reports the renderer’s judgement rather than the caller’s word', selected.writable === false, short(selected));
    check('and names the evidence it got there on', selected.confidence === 'positional', short(selected.confidence));
    check('so the ref select hands back is not a write handle either', dec(selected.ref).w === false, short(dec(selected.ref).w));
    const viaSelect = await run('target', 'set_prop', { ref: selected.ref, name: 'data-via-select', value: '1' });
    check('and a write through the select ref is refused', viaSelect.ok === false && viaSelect.code === 'not_editable', short(viaSelect));
    check('with the page byte-identical', app.read(FILE) === pageBefore);

    // ENTER. Entering is free — no permission level gates it — so if it
    // promoted, the read-only distinction would cost one extra call to defeat.
    const heroBefore = app.read(HERO);
    const entered = await run('target', 'enter', { ref: divergent });
    check('entering through it opens the component', entered.ok === true && entered.entered === 'Hero', short(entered));
    check('and the ref it hands back inherits the caution', dec(entered.target.ref).w === false, short(dec(entered.target.ref).w));
    check('and the answer says the component is not editable through this ref', entered.target.editable === false, short(entered.target.editable));
    const viaEnter = await run('target', 'add_class', { ref: entered.target.ref, className: 'escalated-through-enter' });
    check('so a write through the ref enter handed back is refused', viaEnter.ok === false && viaEnter.code === 'not_editable', short(viaEnter));
    check('and the component file is byte-identical', app.read(HERO) === heroBefore);
    check('and the page it was entered from is too', app.read(FILE) === pageBefore);
    // Every child ref the entered answer carries is held to the same rule —
    // one writable child would be the same hole through a different field.
    const kids = (entered.target.children || []).filter((c) => c.ref);
    check('and no child ref inside that answer is a write handle', kids.length > 0 && kids.every((c) => dec(c.ref).w === false), short(kids.map((c) => dec(c.ref).w)));

    const left = await run('target', 'exit');
    check('and it can be left again', left.ok === true, short(left));
    await H.settle(250);

    // CONTROL, and it is the important half: the same three calls through a ref
    // Stacki DID vouch for still select, still enter and still write.
    const pgNow = await run('target', 'read');
    const heroNow = pgNow.target.children.find((c) => c.tag === 'Hero');
    const selectedOk = await run('target', 'select', { ref: heroNow.ref });
    check('a ref the evidence rules vouch for still selects as a write handle', selectedOk.ok === true && dec(selectedOk.ref).w !== false, short(selectedOk));
    const propOk = await run('target', 'set_prop', { ref: selectedOk.ref, name: 'data-via-select', value: 'ok' });
    check('and writes through it', propOk.ok === true, short(propOk));
    await H.settle(250);
    check('landing on the <Hero>', /<Hero[^>]*data-via-select="ok"/.test(app.read(FILE)), app.read(FILE));

    // Through the ref that write handed back, which is the handle an agent
    // actually carries forward.
    const enteredOk = await run('target', 'enter', { ref: propOk.ref });
    check('and entering through it hands back a write handle', enteredOk.ok === true && dec(enteredOk.target.ref).w !== false, short(enteredOk.ok ? dec(enteredOk.target.ref).w : enteredOk));
    const insideOk = await run('target', 'add_class', { ref: enteredOk.target.ref, className: 'entered-legitimately' });
    check('which writes inside the component', insideOk.ok === true, short(insideOk));
    await H.settle(250);
    check('and the class is in the component file', app.read(HERO).includes('entered-legitimately'), app.read(HERO));

    app.stop();
  }

  // ── 15. A ref keeps the words that identify a node ─────────────────────────
  //
  // The sanitiser that stops a ref carrying a filesystem path walked every
  // string in the payload and dropped anything path.isAbsolute() said was
  // absolute — which is true of "/docs". So a nav whose visible labels are
  // routes minted refs with `fingerprint.text: null`, and a fingerprint with no
  // words is not a tidier fingerprint: src/reviewAnchor.js reads a missing text
  // as nothing to check, which switches off the rung that tells a node from the
  // one that took its slot. Measured below as the difference between finding
  // the link and `ambiguous`.
  {
    const { app, run } = await open({ 'src/pages/index.astro': ROUTE_PAGE });
    const FILE = 'src/pages/index.astro';

    const pg = await run('target', 'read');
    const nav = pg.target.children.find((c) => c.tag === 'nav');
    const readNav = await run('target', 'read', { ref: nav.ref });
    const links = readNav.target.children.filter((c) => c.tag === 'a');
    check('the nav has two links whose words are routes', links.length === 2 && links.map((l) => l.text).join(',') === '/docs,/blog', short(links.map((l) => l.text)));
    check('and a ref for one of them keeps its words', dec(links[0].ref).d.fingerprint.text === '/docs', short(dec(links[0].ref).d.fingerprint.text));
    check('and for the other', dec(links[1].ref).d.fingerprint.text === '/blog', short(dec(links[1].ref).d.fingerprint.text));
    check('while the control with ordinary words is unchanged', dec(pg.target.children.find((c) => c.tag === 'p').ref).d.fingerprint.text === 'ordinary words', short(dec(pg.target.children.find((c) => c.tag === 'p').ref).d.fingerprint.text));
    check('and the breadcrumb labels survive too', (dec(links[1].ref).d.fingerprint.breadcrumbs || []).every((label) => typeof label === 'string' && label.length > 0), short(dec(links[1].ref).d.fingerprint.breadcrumbs));

    // AND THE WORDS ARE WHAT FINDS IT AGAIN. Insert a third link above both, so
    // every index path in the run shifts and the sibling run changes size: the
    // slot proof is gone and the only thing left that says which link this is
    // is what it says.
    const blogRef = links[1].ref;
    const added = await run('target', 'insert_before', { ref: links[0].ref, node: { kind: 'element', tag: 'a' } });
    check('a third link can be inserted above them', added.ok === true, short(added));
    await H.settle(250);
    check('and the run is a different size now', (app.read(FILE).match(/<a[\s>]/g) || []).length === 3, app.read(FILE));

    const found = await run('target', 'read', { ref: blogRef });
    check('the ref for the second link still finds it', found.ok === true, short(found));
    check('and finds the link it named rather than the one now in its slot', found.ok && found.target.text?.value === '/blog', short(found.ok ? found.target.text : found.code));

    // On disk, through the ref that read hands back — the documented way back
    // from a moved node, and the only oracle that proves the right <a>.
    // Guarded rather than assumed: with the words gone the read above answers
    // `ambiguous` and there is no ref to follow, which is a failed check here
    // and not a stack trace that stops the rest of the suite.
    const landed = found.ok
      ? await run('target', 'add_class', { ref: found.target.ref, className: 'the-blog-link' })
      : { ok: false, code: 'the read never handed a ref back' };
    check('and a write through it lands', landed.ok === true, short(landed));
    await H.settle(250);
    const markup = app.read(FILE);
    const carrying = markup.split('\n').filter((line) => line.includes('the-blog-link'));
    check('on the /blog link', carrying.length === 1 && carrying[0].includes('href="/blog"'), markup);
    check('and on nothing else', (markup.match(/the-blog-link/g) || []).length === 1, markup);

    // The rule this sanitiser exists for is still enforced: no field a ref
    // resolves as a PLACE names one on this machine.
    const paths = [];
    const walkPaths = (value, key) => {
      if (typeof value === 'string') {
        if (['route', 'text', 'label', 'breadcrumbs', 'tag', 'name'].includes(key)) return;
        if (path.isAbsolute(value)) paths.push(`${key}=${value}`);
        return;
      }
      if (Array.isArray(value)) return value.forEach((item) => walkPaths(item, key));
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, item]) => walkPaths(item, k));
    };
    if (found.ok) walkPaths(dec(found.target.ref), null);
    check('and no place-naming field in the ref is absolute', found.ok && paths.length === 0, short(paths));

    app.stop();
  }

  // ── 16. Through a ref the PRODUCT mints read-only, in a tree that has not moved
  //
  // The section above builds a ref the renderer would refuse on its own
  // evidence, so it cannot tell which half of the guard is doing the work. This
  // one can. A binding's `instanceRef` is minted `writable: false` deliberately
  // — it names a node in a document that read never looked at — and it resolves
  // PERFECTLY: nothing has moved, the renderer places it exactly and, asked, it
  // vouches for it. The only thing between that ref and a write is the main
  // process carrying its flag across.
  //
  // Which makes the rule this pins a rule about ONE call rather than about
  // permission in general: `select` is the documented way to turn a pointer
  // into a handle, because it puts the node in front of the person and re-mints
  // against a document it has just observed. `read` inherits the caution and so
  // does `enter` — entering costs nothing and is not gated, so if it promoted, a
  // read-only ref would be one free call away from a write handle.
  {
    const { app, run } = await open();
    const HERO = 'src/components/Hero.astro';

    const pg = await run('target', 'read');
    const hero = pg.target.children.find((c) => c.tag === 'Hero');
    const opened = await run('target', 'enter', { ref: hero.ref });
    const inner = opened.target.children.find((c) => c.tag === 'p');
    const readInner = await run('target', 'read', { ref: inner.ref });
    const binding = (readInner.target.bindings || []).find((b) => b.source?.instanceRef);
    check('a prop binding names the instance that sets it', !!binding, short(readInner.target.bindings));
    const instanceRef = binding.source.instanceRef;
    check('and the product minted that pointer read-only', dec(instanceRef).w === false, short(dec(instanceRef)));
    await run('target', 'exit');
    await H.settle(250);

    // THE PIVOT. Nothing has moved, so the renderer re-derives full confidence
    // and says so — this is the case where the renderer has no objection of its
    // own, and select promotes on exactly that judgement.
    const selected = await run('target', 'select', { ref: instanceRef });
    check('selecting through it re-derives the evidence', selected.ok === true && selected.confidence === 'exact', short(selected));
    check('and the renderer does vouch for this one', selected.writable !== false, short(selected.writable));
    check('so select hands back a write handle, as it is documented to', dec(selected.ref).w !== false, short(dec(selected.ref).w));
    check('carrying an observation the pointer never had', dec(selected.ref).o?.revision != null, short(dec(selected.ref).o));

    // CONTROL, taken here while nothing has moved: the handle select handed
    // over really does write, and lands where it said. A section where the
    // pointer is refused everywhere would prove that enter is broken rather
    // than that it is careful.
    const componentUntouched = app.read(HERO);
    const wrote = await run('target', 'set_prop', { ref: selected.ref, name: 'data-through-select', value: 'ok' });
    check('the handle select handed over writes', wrote.ok === true, short(wrote));
    await H.settle(250);
    check('and lands on the <Hero> in the page', /<Hero[^>]*data-through-select="ok"/.test(app.read('src/pages/index.astro')), app.read('src/pages/index.astro'));
    check('and never touched the component file', app.read(HERO) === componentUntouched);

    // AND ENTER DOES NOT, through the identical ref in the identical tree.
    await H.settle(200);
    const heroBefore = app.read(HERO);
    const entered = await run('target', 'enter', { ref: instanceRef });
    check('entering through the pointer opens the component', entered.ok === true && entered.entered === 'Hero', short(entered));
    check('and the ref it hands back is not a write handle', dec(entered.target.ref).w === false, short(dec(entered.target.ref).w));
    const inside = await run('target', 'add_class', { ref: entered.target.ref, className: 'through-a-pointer' });
    check('so a write through it is refused', inside.ok === false && inside.code === 'not_editable', short(inside));
    check('and the component file is byte-identical', app.read(HERO) === heroBefore);
    const kids = (entered.target.children || []).filter((c) => c.ref);
    check('and no child ref in that answer is a write handle either', kids.length > 0 && kids.every((c) => dec(c.ref).w === false), short(kids.map((c) => dec(c.ref).w)));

    // EXIT takes no ref, so there is nothing for it to inherit. It answers with
    // the LIVE SELECTION — the same thing a refless `target.read` answers with,
    // writable for the same reason it is: it is what is in front of the person.
    // Measured rather than assumed, because "enter and exit both hardcode
    // writable" reads like one fact and is two.
    const left = await run('target', 'exit');
    check('exit comes back out', left.ok === true, short(left));
    await H.settle(250);
    const live = await run('target', 'read');
    check('and answers about the same node a refless read answers about', JSON.stringify(left.keys) === JSON.stringify(live.target.keys), `${short(left.keys)} vs ${short(live.target.keys)}`);
    check('with the same permission on it', dec(left.target.ref).w === dec(live.target.ref).w, `${short(dec(left.target.ref).w)} vs ${short(dec(live.target.ref).w)}`);

    app.stop();
  }

  // ── 17. A file ref names the file the READ resolved ────────────────────────
  //
  // A ref is handed out BY a read, and a write is supposed to be able to carry
  // it straight back — "nothing to remember and nothing to copy wrongly".
  // `asset.read_text` and `style.read_source` minted theirs from the CLIENT'S
  // OWN STRING while every other minter in the file used the resolved path, so
  // a read spelled 'public/./robots.txt' handed back a ref that the write then
  // refused as `wrong_target`, accusing the caller of naming a different file
  // with the ref that read had just given it. Fail-closed and still wrong: the
  // same file had two ref identities that did not compare equal.
  //
  // Spellings a resolver is expected to absorb, all naming ONE file, and the
  // oracle is the bytes: the write through each ref has to land.
  {
    const { root, app, run } = await open();
    const spellings = (rel) => {
      const cut = rel.lastIndexOf('/');
      const dir = rel.slice(0, cut);
      const name = rel.slice(cut + 1);
      return [rel, `${dir}/./${name}`, `./${rel}`, `${dir}//${name}`, `${dir}/nowhere/../${name}`];
    };

    const CSS = 'src/styles/site.css';
    const ROBOTS = 'public/robots.txt';

    for (const spelling of spellings(ROBOTS)) {
      const read = await run('asset', 'read_text', { path: spelling });
      check(`asset.read_text reads ${spelling}`, read.ok === true, short(read));
      check('  and answers with the resolved path', read.path === ROBOTS, short({ path: read.path }));
      check('  and mints the ref against that path', dec(read.ref)?.d?.path === ROBOTS, short(dec(read.ref)?.d));
      const marker = `# spelled ${spelling}\n`;
      const wrote = await run('asset', 'write_text', { path: ROBOTS, ref: read.ref, text: marker });
      check('  and the write through that ref lands', wrote.ok === true, short(wrote));
      check('  on disk', app.read(ROBOTS) === marker, short(app.read(ROBOTS)));
    }

    for (const spelling of spellings(CSS)) {
      const read = await run('style', 'read_source', { path: spelling });
      check(`style.read_source reads ${spelling}`, read.ok === true, short(read));
      check('  and answers with the resolved path', read.path === CSS, short({ path: read.path }));
      check('  and mints the ref against that path', dec(read.ref)?.d?.path === CSS, short(dec(read.ref)?.d));
      const css = `${read.css}/* spelled ${spelling} */\n`;
      const wrote = await run('style', 'write_source', { path: CSS, ref: read.ref, css });
      check('  and the write through that ref lands', wrote.ok === true, short(wrote));
      check('  on disk', app.read(CSS) === css, short(app.read(CSS).slice(-60)));
    }

    // THE NEIGHBOURS, which have always resolved before minting. They are here
    // so that "every read agrees about what a file is called" is one statement
    // rather than two, and so a fix that normalised only where it was measured
    // shows up.
    for (const spelling of spellings(CSS)) {
      const read = await run('source', 'read', { path: spelling });
      check(`source.read mints against the resolved path for ${spelling}`, dec(read.ref)?.d?.path === CSS, short(dec(read.ref)?.d));
    }
    for (const spelling of spellings('src/data/site.json')) {
      const read = await run('content', 'cms_read', { path: spelling });
      check(`content.cms_read mints against the resolved path for ${spelling}`, dec(read.ref)?.d?.path === 'src/data/site.json', short(dec(read.ref)?.d));
    }

    // THE CONTROL THAT KEEPS IT HONEST. Normalising must not turn the guard
    // off: a ref for a different file, used here, is still refused and still
    // writes nothing.
    const other = await run('asset', 'read_text', { path: ROBOTS });
    const cssBefore = app.read(CSS);
    const crossed = await run('style', 'write_source', { path: CSS, ref: other.ref, css: 'body{}\n' });
    check('a ref for another file is still refused', crossed.ok === false && crossed.code === 'wrong_target', short(crossed));
    check('  and nothing was written', app.read(CSS) === cssBefore, short(app.read(CSS).slice(-60)));
    // A climb that comes back in is the same file, and says so.
    const roundTrip = await run('asset', 'read_text', { path: `../${path.basename(root)}/${ROBOTS}` });
    check('a spelling that climbs out and back in names the one file', roundTrip.ok === true && roundTrip.path === ROBOTS, short({ ok: roundTrip.ok, path: roundTrip.path }));
    // And one that genuinely leaves is still refused before any of this.
    const outside = await run('asset', 'read_text', { path: '../not-in-any-project.txt' });
    check('a spelling that leaves the project is still refused', outside.ok === false && outside.code === 'outside_project', short(outside));

    app.stop();
  }

  for (const root of projects) H.removeProject(root);

  if (failures.length) {
    console.error(`\nref-concurrency: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`ref-concurrency: ${checked} passed  [no unobserved write handle, and no refusal that writes]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
