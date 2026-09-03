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
