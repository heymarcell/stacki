// What page.component_create must refuse, and what it must leave behind.
//
//   node test/mcp-component-create.js
//
// The operation writes a file and then rewrites the page. That order is why
// every refusal here is checked for SIDE EFFECTS as well as for a code: a
// guard that fires after the file is written is not a guard, it is an
// apology.
//
// It also exists because the first version of the ref fix was wrong in a way
// no positive test could see. The renderer dispatch took `parsed.data` and
// dropped `parsed.writable` and `parsed.observed`, which made this write
// quietly weaker than the identical target.edit beside it — a read-only ref
// honoured there and ignored here, and a stale ref creating a component
// against a document it had never seen. Both of those are now tests.

const fs = require('node:fs');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { startWireRig } = require('./support/mcpWireRig.js');

// An envelope that never arrived is exactly what a broken guard produces, so
// the detail formatter must survive one. Crashing here would hide the failure
// it was written to report.
const brief = (value, n = 200) => {
  try {
    return value === undefined ? '(no structuredContent — the call errored)' : JSON.stringify(value).slice(0, n);
  } catch {
    return String(value);
  }
};

/** Nothing this operation makes may exist. Checked after every refusal. */
const noTrace = (rig, name) => {
  const page = rig.harness.read('src/pages/index.astro');
  return {
    file: !rig.harness.exists(`src/components/${name}.astro`),
    imported: !new RegExp(`import\\s+${name}\\s+from`).test(page),
    instanced: !new RegExp(`<${name}`).test(page),
    // The div itself, not the exact attribute text: a legitimate edit in the
    // stale-ref case adds a class to it, and that is not this operation.
    markupIntact: page.includes('pricing-grid'),
  };
};

const divRef = async (rig) => {
  const { envelope } = await rig.call('target', 'read');
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    flat.push(n);
    (n.children || []).forEach(walk);
  };
  walk(envelope?.target);
  return flat.find((n) => String(n.tag || '').toLowerCase() === 'div')?.ref || null;
};

(async () => {
  // ── a stale ref may not write ────────────────────────────────────────────
  //
  // Read the node, change the same document through another honest operation,
  // then try to extract with the ref from before. The ref carries what it saw;
  // that is the guard, and the caller never has to repeat it.
  {
    const rig = await startWireRig();
    try {
      const stale = await divRef(rig);
      check('a ref was obtained', !!stale);

      // Something else legitimately edits the same page.
      const edited = await rig.call('target', 'add_class', { ref: await divRef(rig), className: 'moved-on' });
      check('the document really did change underneath it', edited.envelope?.ok === true, brief(edited.envelope, 160));

      const out = await rig.call('page', 'component_create', { name: 'WireCard', ref: stale, withProps: true });
      check('a stale ref is refused', out.envelope?.ok === false, brief(out.envelope, 200));
      check('  by name', out.envelope?.code === 'stale_target', String(out.envelope?.code));

      const trace = noTrace(rig, 'WireCard');
      check('  and no component file was written', trace.file);
      check('  the page has no import for it', trace.imported);
      check('  no instance was rendered', trace.instanced);
      check('  and the original markup is still there', trace.markupIntact);

      // A fresh ref, and the same call, works — so the refusal was about
      // staleness and not about the operation being broken.
      const fresh = await rig.call('page', 'component_create', { name: 'WireCard', ref: await divRef(rig), withProps: true });
      check('a fresh ref succeeds', fresh.envelope?.ok === true, brief(fresh.envelope, 200));
    } finally {
      await rig.stop();
    }
  }

  // ── a read-only ref may not write ────────────────────────────────────────
  //
  // Minted through the real ref machinery rather than hand-rolled, so this
  // fails the moment the dispatch stops carrying `parsed.writable`.
  {
    const rig = await startWireRig();
    try {
      const api = rig.harness.api;
      const live = await divRef(rig);
      const parsed = api.readRef ? api.readRef(live, 'node') : null;
      const readOnly = parsed?.ok && api.nodeRef ? api.nodeRef(parsed.data, { writable: false, observed: parsed.observed || null }) : null;
      if (!check('a read-only ref could be minted through the real machinery', !!readOnly, 'api.readRef/nodeRef unavailable')) {
        return;
      }

      const out = await rig.call('page', 'component_create', { name: 'ReadOnlyCard', ref: readOnly, withProps: true });
      check('a read-only ref is refused', out.envelope?.ok === false, brief(out.envelope, 200));
      check('  by name', out.envelope?.code === 'not_editable', String(out.envelope?.code));

      const trace = noTrace(rig, 'ReadOnlyCard');
      check('  and nothing was written', trace.file && trace.imported && trace.instanced && trace.markupIntact, brief(trace));
    } finally {
      await rig.stop();
    }
  }

  // ── the other ways a ref can be wrong ────────────────────────────────────
  {
    const rig = await startWireRig();
    try {
      const bad = await rig.call('page', 'component_create', { name: 'NopeCard', ref: 'stacki:not-a-real-ref', withProps: true });
      check('a malformed ref is refused', bad.envelope?.ok === false, brief(bad.envelope, 160));
      check('  and not silently treated as no ref at all', bad.envelope?.code !== 'no_target', String(bad.envelope?.code));

      // A source ref where a node ref belongs: the kind must be checked rather
      // than collapsed into a generic parse failure.
      const src = await rig.call('source', 'read', { path: 'src/pages/index.astro' });
      const sourceRef = src.envelope?.ref;
      if (sourceRef) {
        const wrongKind = await rig.call('page', 'component_create', { name: 'WrongKind', ref: sourceRef, withProps: true });
        check('a source ref is refused where a node ref belongs', wrongKind.envelope?.ok === false, brief(wrongKind.envelope, 160));
        check('  and says the kind is wrong rather than blaming the bytes', /kind/i.test(String(wrongKind.envelope?.code) + String(wrongKind.envelope?.message)), brief(wrongKind.envelope, 200));
      }

      const trace = noTrace(rig, 'NopeCard');
      check('no refusal left a file behind', trace.file && trace.markupIntact, brief(trace));
    } finally {
      await rig.stop();
    }
  }

  // ── names ────────────────────────────────────────────────────────────────
  {
    const rig = await startWireRig();
    try {
      const lower = await rig.call('page', 'component_create', { name: 'wirecard', ref: await divRef(rig), withProps: true });
      check('a name that is not a component name is refused', lower.envelope?.ok === false, brief(lower.envelope, 160));
      check('  and wrote nothing', !rig.harness.exists('src/components/wirecard.astro') && rig.harness.read('src/pages/index.astro').includes('class="pricing-grid"'));

      const clash = await rig.call('page', 'component_create', { name: 'Card', ref: await divRef(rig), withProps: true });
      check('an existing component name is refused', clash.envelope?.ok === false, brief(clash.envelope, 160));
      check('  and the component it would have clashed with is untouched', rig.harness.read('src/components/Card.astro').includes('Astro.props'));
      check('  and the page still has its markup', rig.harness.read('src/pages/index.astro').includes('class="pricing-grid"'));
    } finally {
      await rig.stop();
    }
  }

  // ── withProps: false is a supported choice, not a broken state ───────────
  {
    const rig = await startWireRig();
    try {
      const out = await rig.call('page', 'component_create', { name: 'RawWireCard', ref: await divRef(rig), withProps: false });
      check('extracting without props succeeds', out.envelope?.ok === true, brief(out.envelope, 200));
      const made = rig.harness.exists('src/components/RawWireCard.astro') ? rig.harness.read('src/components/RawWireCard.astro') : '';
      const page = rig.harness.read('src/pages/index.astro');
      check('  the markup still names what it was reading', /plans\.map/.test(made), made.slice(0, 160));
      check('  no props were invented for it', (out.envelope?.props || []).length === 0, brief(out.envelope?.props));
      check('  the instance passes nothing in', /<RawWireCard\s*\/?>/.test(page) || !/plans=\{plans\}/.test(page.split('<RawWireCard')[1] || ''), page.slice(0, 200));
      // Said plainly, because the component now reads scope it no longer has.
      check('  and it says the markup was left stranded', out.envelope?.stranded === true, String(out.envelope?.stranded));
    } finally {
      await rig.stop();
    }
  }

  if (failures.length) {
    console.error(`\nmcp-component-create: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`mcp-component-create: ${checked} passed  [stale, read-only, wrong kind, names, withProps:false — and no refusal writes]`);
})().catch((err) => {
  console.error('mcp-component-create threw\n', err);
  process.exit(1);
});
