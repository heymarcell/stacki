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

  // ── the half-completed operation, and what it owes ───────────────────────
  //
  // component_create writes the component file and THEN rewrites the page. A
  // node that disappears between those two moments leaves a component nobody
  // asked for and a page that never changed. Reporting that as success would be
  // saying "turned it into a component" about markup still sitting where it was.
  //
  // The rollback branch for that existed and had never once run. It could not
  // have worked: it called `deletePage({ projectPath, path })` while the
  // shipping handler takes the path itself — `handle('page:delete', (_e,
  // pagePath) => fs.rmSync(pagePath))` — and the human caller passes
  // `page.path`. Source presence is not proof; these two tests force the seam.
  //
  // The condition is made by wrapping the REAL `component:create` handler in
  // the harness's own map: the original runs and genuinely writes the file,
  // then the target is removed through an honest Stacki edit, and the outer
  // extraction resumes to find nothing to replace. Nothing is faked — the
  // operation still travels the whole MCP → Agent → renderer path.

  const intercept = (rig, channel, wrap) => {
    const handlers = rig.harness.handlers;
    const original = handlers.get(channel);
    if (!original) throw new Error(`the harness has no ${channel} handler to wrap`);
    handlers.set(channel, (...args) => wrap(original, ...args));
    return () => handlers.set(channel, original);
  };

  // A. the target vanishes, and the rollback works
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      const deleteCalls = [];

      // Watch what the rollback actually hands the delete handler. If somebody
      // later goes back to passing an object, this names it.
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        deleteCalls.push(payload);
        return original(event, payload);
      });

      let fileExistedBeforeRollback = false;
      const restoreCreate = intercept(rig, 'component:create', async (original, event, payload) => {
        const made = await original(event, payload);
        fileExistedBeforeRollback = rig.harness.exists('src/components/WireCard.astro');
        // The node goes away through a real edit, the way a concurrent change
        // would take it — not by poking at React internals.
        await rig.call('target', 'remove', { ref: await divRef(rig) });
        return made;
      });
      restore = () => {
        restoreCreate();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'WireCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('a half-completed extraction is a failure', out.envelope?.ok === false, brief(out.envelope));
      check('  named for the node that went away', out.envelope?.code === 'no_node', String(out.envelope?.code));
      check('  the component file really was written first', fileExistedBeforeRollback);
      check('  and the rollback removed it', !rig.harness.exists('src/components/WireCard.astro'));
      check('  it reports nothing was left behind', !out.envelope?.leftBehind, brief(out.envelope?.leftBehind));

      const page = rig.harness.read('src/pages/index.astro');
      check('  the page has no import from the failed extraction', !/import\s+WireCard\s+from/.test(page));
      check('  and no instance from it', !/<WireCard/.test(page));
      check('  the concurrent removal that caused this is preserved', !page.includes('pricing-grid'), page.slice(0, 200));
      check('  and the rest of the page survived', page.includes('<Hero') && page.includes('<footer'));

      // THE CONTRACT. A string, because that is what page:delete takes.
      const own = deleteCalls.filter((c) => typeof c === 'string' && c.endsWith('WireCard.astro'));
      check('  cleanup called page:delete with the created path as a string', own.length === 1, `saw ${brief(deleteCalls)}`);
      check('  and targeted only the file this operation made', deleteCalls.every((c) => typeof c === 'string' && c.endsWith('WireCard.astro')), brief(deleteCalls));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // B. the target vanishes and the rollback ITSELF fails
  //
  // The honest outcome is still a failure, and it has to say what it could not
  // take back. A response claiming a clean state while an orphan sits on disk
  // is worse than an explicit failure.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        if (typeof payload === 'string' && payload.endsWith('OrphanCard.astro')) {
          throw new Error('test-owned failure: this deletion is not allowed');
        }
        return original(event, payload);
      });
      const restoreCreate = intercept(rig, 'component:create', async (original, event, payload) => {
        const made = await original(event, payload);
        await rig.call('target', 'remove', { ref: await divRef(rig) });
        return made;
      });
      restore = () => {
        restoreCreate();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'OrphanCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('a failed rollback is still a failure', out.envelope?.ok === false, brief(out.envelope));
      // The message is the truthful carrier here: `leftBehind` is not a
      // declared Envelope field, so it does not survive the wire.
      check('  it does not claim a clean state', /left behind/i.test(String(out.envelope?.message)), brief(out.envelope));
      check('  and names what it could not take back', /OrphanCard/.test(String(out.envelope?.leftBehind) + String(out.envelope?.message)), brief(out.envelope));
      check('  the orphan really is on disk', rig.harness.exists('src/components/OrphanCard.astro'));

      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the failed extraction', !/import\s+OrphanCard\s+from/.test(page));
      check('  and no instance', !/<OrphanCard/.test(page));

      // The test made this orphan; the test accounts for it rather than leaving
      // it to the fixture teardown to sweep up.
      fs.rmSync(path.join(rig.root, 'src/components/OrphanCard.astro'), { force: true });
      check('  and the test removed the artifact it deliberately created', !rig.harness.exists('src/components/OrphanCard.astro'));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // C. the rollback is REFUSED rather than throwing
  //
  // A separate case from B on purpose. When page:delete throws, any `catch`
  // keeps `leftBehind` set and the operation looks careful whether or not it
  // checked anything. A handler that answers `{ ok: false }` and removes
  // nothing is the one that finds out whether the result is actually read —
  // and without this, dropping the confirmation entirely changed no test.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        if (typeof payload === 'string' && payload.endsWith('RefusedCard.astro')) {
          return { ok: false, message: 'test-owned refusal: nothing was removed' };
        }
        return original(event, payload);
      });
      const restoreCreate = intercept(rig, 'component:create', async (original, event, payload) => {
        const made = await original(event, payload);
        await rig.call('target', 'remove', { ref: await divRef(rig) });
        return made;
      });
      restore = () => {
        restoreCreate();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'RefusedCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('a refused rollback is a failure', out.envelope?.ok === false, brief(out.envelope));
      check('  and is not reported as a clean state', /left behind/i.test(String(out.envelope?.message)), brief(out.envelope));
      check('  naming the component still on disk', /RefusedCard/.test(String(out.envelope?.message)), brief(out.envelope));
      check('  which really is still there', rig.harness.exists('src/components/RefusedCard.astro'));

      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the failed extraction', !/import\s+RefusedCard\s+from/.test(page));
      check('  and no instance', !/<RefusedCard/.test(page));

      fs.rmSync(path.join(rig.root, 'src/components/RefusedCard.astro'), { force: true });
      check('  and the test removed the artifact it deliberately created', !rig.harness.exists('src/components/RefusedCard.astro'));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // D. an exception between creating the file and replacing the node
  //
  // A, B and C all arrive at the rollback through the `!replaced` branch, which
  // only runs if execution reaches it. The file is on disk one statement
  // earlier than that, and page:importPathFor sits in between — an IPC call
  // like any other, free to reject. If it does, the function unwinds past the
  // rollback entirely and the component stays behind with nothing pointing at
  // it and nobody saying so.
  //
  // The failure is injected at the real page:importPathFor handler, after the
  // real component:create has already written the file, so the orphan in this
  // test is a genuine one.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      let fileExistedBeforeFailure = null;
      const deleteCalls = [];

      const restorePath = intercept(rig, 'page:importPathFor', (original, event, payload) => {
        if (String(payload?.targetPath || '').endsWith('StrandedCard.astro')) {
          fileExistedBeforeFailure = rig.harness.exists('src/components/StrandedCard.astro');
          throw new Error('test-owned failure: the import path could not be worked out');
        }
        return original(event, payload);
      });
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        deleteCalls.push(payload);
        return original(event, payload);
      });
      restore = () => {
        restorePath();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'StrandedCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('a failure after the file is written is not a success', out.envelope?.ok === false, brief(out.envelope));
      check('  and the file really had been written first', fileExistedBeforeFailure === true, `saw ${fileExistedBeforeFailure}`);
      check('  the operation compensated instead of unwinding', deleteCalls.length === 1, `saw ${brief(deleteCalls)}`);
      check(
        '  passing the created path as a string',
        deleteCalls.every((c) => typeof c === 'string' && c.endsWith('StrandedCard.astro')),
        brief(deleteCalls)
      );
      check('  so nothing is left on disk', !rig.harness.exists('src/components/StrandedCard.astro'));
      check('  and it says so rather than naming a leftover', !/left behind/i.test(String(out.envelope?.message)), brief(out.envelope));

      // The replacement was never reached, so the page must be exactly as it
      // was — including the node this operation was asked to move.
      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the abandoned extraction', !/import\s+StrandedCard\s+from/.test(page));
      check('  and no instance', !/<StrandedCard/.test(page));
      check('  the original subtree still in place', page.includes('pricing-grid'), brief(page, 300));
      check('  and the rest of the page untouched', page.includes('<Hero') && page.includes('<footer'), brief(page, 300));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // E. the same exception, with the compensation itself refused
  //
  // The pre-replacement seam has to be as honest as the `!replaced` one: if it
  // cannot take the file back, it says which file it could not take back.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);

      const restorePath = intercept(rig, 'page:importPathFor', (original, event, payload) => {
        if (String(payload?.targetPath || '').endsWith('MaroonedCard.astro')) {
          throw new Error('test-owned failure: the import path could not be worked out');
        }
        return original(event, payload);
      });
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        if (typeof payload === 'string' && payload.endsWith('MaroonedCard.astro')) {
          return { ok: false, message: 'test-owned refusal: nothing was removed' };
        }
        return original(event, payload);
      });
      restore = () => {
        restorePath();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'MaroonedCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('a failed compensation is still a failure', out.envelope?.ok === false, brief(out.envelope));
      check('  which does not claim a clean state', /left behind/i.test(String(out.envelope?.message)), brief(out.envelope));
      check('  and names the component it could not remove', /MaroonedCard/.test(String(out.envelope?.message)), brief(out.envelope));
      check('  which really is still there', rig.harness.exists('src/components/MaroonedCard.astro'));

      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the abandoned extraction', !/import\s+MaroonedCard\s+from/.test(page));
      check('  and no instance', !/<MaroonedCard/.test(page));
      check('  the original subtree still in place', page.includes('pricing-grid'), brief(page, 300));
      check('  and the rest of the page untouched', page.includes('<Hero') && page.includes('<footer'), brief(page, 300));

      fs.rmSync(path.join(rig.root, 'src/components/MaroonedCard.astro'), { force: true });
      check('  and the test removed the artifact it deliberately created', !rig.harness.exists('src/components/MaroonedCard.astro'));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // F. the other side of the boundary
  //
  // D and E prove the file is taken back when the page never committed. This
  // proves the opposite duty, which is the easier one to get wrong: once the
  // page holds the import and the instance, the component file is no longer
  // this operation's to withdraw. A step that fails afterwards — here the
  // project rescan — must not be answered by deleting a file the page now
  // points at, because that turns a page that was changed correctly into a
  // page with a broken import.
  //
  // The failure is injected after component:create has run, so it lands past
  // the replacement rather than before it.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      let past = false;

      const restoreCreate = intercept(rig, 'component:create', async (original, event, payload) => {
        const made = await original(event, payload);
        past = true;
        return made;
      });
      const restoreScan = intercept(rig, 'project:scan', (original, event, payload) => {
        if (past) throw new Error('test-owned failure: the project could not be rescanned');
        return original(event, payload);
      });
      restore = () => {
        restoreCreate();
        restoreScan();
      };

      const out = await rig.call('page', 'component_create', { name: 'CommittedCard', ref: target, withProps: true });
      restore();
      restore = null;

      // A pending save is on a timer; another honest wire call gives it the
      // turn of the loop it needs before the file is read.
      await rig.call('target', 'read');
      const page = rig.harness.read('src/pages/index.astro');

      check('the component survives a failure after the page committed', rig.harness.exists('src/components/CommittedCard.astro'));
      check('  because the page now imports it', /import\s+CommittedCard\s+from/.test(page), brief(page, 300));
      check('  and holds an instance of it', /<CommittedCard/.test(page), brief(page, 300));
      check('  the extracted markup having moved out of the page', !page.includes('pricing-grid'), brief(page, 300));
      check('  and the rest of the page untouched', page.includes('<Hero') && page.includes('<footer'), brief(page, 300));
      // The mutation happened, so the mutation is reported as having happened.
      // An agent handed ok:false here would reasonably run component_create
      // again, against a page that already has the component in it.
      check('  the operation reports the mutation it actually made', out.envelope?.ok === true, brief(out.envelope));
      check('  and does not answer with a retry-inducing failure code', !out.envelope?.code, brief(out.envelope));
      check('  while saying out loud that the refresh failed', (out.envelope?.notes || []).some((n) => /rescan/i.test(String(n))), brief(out.envelope?.notes));
      check('  naming what is stale rather than what is broken', (out.envelope?.notes || []).some((n) => /stale|out of date/i.test(String(n))), brief(out.envelope?.notes));
      check('  and no leftover claimed, because there is none', !/left behind/i.test(String(out.envelope?.message || '')), brief(out.envelope));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // G. the import path RESOLVES, with something the next step cannot use
  //
  // D injects a rejection, which any try/catch around an await will see. This
  // one resolves — successfully — with null, and the failure happens further
  // in, inside the callback handed to mutateModel, where chooseImportPath
  // destructures it. That callback is queued state work, so a `try` wrapped
  // around the setter call is not obviously the thing that catches it, and
  // `replaced` set from inside it is not obviously readable after it. This is
  // the case that finds out whether the transaction has an oracle or a habit.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);
      let fileExistedBeforeFailure = null;
      const deleteCalls = [];

      const restorePath = intercept(rig, 'page:importPathFor', (original, event, payload) => {
        if (String(payload?.targetPath || '').endsWith('MalformedCard.astro')) {
          fileExistedBeforeFailure = rig.harness.exists('src/components/MalformedCard.astro');
          return null;
        }
        return original(event, payload);
      });
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        deleteCalls.push(payload);
        return original(event, payload);
      });
      restore = () => {
        restorePath();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'MalformedCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('an unusable import path is a failure, not a success', out.envelope?.ok === false, brief(out.envelope));
      check('  and the file really had been written first', fileExistedBeforeFailure === true, `saw ${fileExistedBeforeFailure}`);
      check('  the operation compensated instead of unwinding', deleteCalls.length === 1, `saw ${brief(deleteCalls)}`);
      check(
        '  passing the created path as a string',
        deleteCalls.every((c) => typeof c === 'string' && c.endsWith('MalformedCard.astro')),
        brief(deleteCalls)
      );
      check('  so nothing is left on disk', !rig.harness.exists('src/components/MalformedCard.astro'));
      check('  and it does not name a leftover it does not have', !/left behind/i.test(String(out.envelope?.message)), brief(out.envelope));

      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the abandoned extraction', !/import\s+MalformedCard\s+from/.test(page));
      check('  and no instance', !/<MalformedCard/.test(page));
      check('  the original subtree still in place', page.includes('pricing-grid'), brief(page, 300));
      check('  and the rest of the page untouched', page.includes('<Hero') && page.includes('<footer'), brief(page, 300));

      // The page model has to be as untouched as the file on disk: a half-applied
      // import with no instance would be a broken page that the source check
      // above could still miss if the save had not landed yet.
      const after = await rig.call('target', 'read');
      const flat = [];
      const walk = (n) => { if (!n) return; flat.push(n); (n.children || []).forEach(walk); };
      walk(after.envelope?.target);
      check('  and the live model holds no instance either', !flat.some((n) => n.name === 'MalformedCard'), brief(flat.map((n) => n.tag || n.name)));
    } finally {
      if (restore) restore();
      await rig.stop();
    }
  }

  // H. the same unusable import path, with the compensation refused
  //
  // G proves the failure is caught and answered. This proves the answer stays
  // honest when the taking-back does not work either.
  {
    const rig = await startWireRig();
    let restore = null;
    try {
      const target = await divRef(rig);

      const restorePath = intercept(rig, 'page:importPathFor', (original, event, payload) => {
        if (String(payload?.targetPath || '').endsWith('StuckCard.astro')) return null;
        return original(event, payload);
      });
      const restoreDelete = intercept(rig, 'page:delete', (original, event, payload) => {
        if (typeof payload === 'string' && payload.endsWith('StuckCard.astro')) {
          return { ok: false, message: 'test-owned refusal: nothing was removed' };
        }
        return original(event, payload);
      });
      restore = () => {
        restorePath();
        restoreDelete();
      };

      const out = await rig.call('page', 'component_create', { name: 'StuckCard', ref: target, withProps: true });
      restore();
      restore = null;

      check('an unusable import path with a refused cleanup is still a failure', out.envelope?.ok === false, brief(out.envelope));
      check('  which does not claim a clean state', /left behind/i.test(String(out.envelope?.message)), brief(out.envelope));
      check('  and names the component it could not remove', /StuckCard/.test(String(out.envelope?.message)), brief(out.envelope));
      check('  which really is still there', rig.harness.exists('src/components/StuckCard.astro'));

      const page = rig.harness.read('src/pages/index.astro');
      check('  with no import from the abandoned extraction', !/import\s+StuckCard\s+from/.test(page));
      check('  and no instance', !/<StuckCard/.test(page));
      check('  the original subtree still in place', page.includes('pricing-grid'), brief(page, 300));
      check('  and the rest of the page untouched', page.includes('<Hero') && page.includes('<footer'), brief(page, 300));
      check('  and no unrelated component removed', rig.harness.exists('src/components/Card.astro') && rig.harness.exists('src/components/Hero.astro'));

      fs.rmSync(path.join(rig.root, 'src/components/StuckCard.astro'), { force: true });
      check('  and the test removed the artifact it deliberately created', !rig.harness.exists('src/components/StuckCard.astro'));
    } finally {
      if (restore) restore();
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
