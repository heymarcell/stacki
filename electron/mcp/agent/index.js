// The Agent API, assembled.
//
// Everything above this file describes a piece of it — the operations and what
// they cost (registry), who may run them (permissions), what a target is
// (refs), whether a write is still current (digest), where a path may point
// (paths), what each operation actually calls (domains). This is the order
// they happen in, and it is the same order every single time:
//
//   is a project open
//   is this an operation at all
//   may this permission level run it
//   is the ref real, ours, current, and about this project
//   is the document still the one the caller read
//   do it — through the renderer for anything the editor owns, through the
//     handler the panels call for anything else
//   say what changed, with evidence
//
// The thing worth noticing is what is NOT in that list: there is no step where
// this file decides how to create a page, write an entry or move a node. It
// cannot, because it does not know how; those live in one place each and this
// calls them. That is the difference between an API over an editor and a
// second editor.

const fs = require('node:fs');
const path = require('node:path');

const registry = require('./registry');
const permissions = require('./permissions');
const refs = require('./refs');
const { runMain } = require('./domains');
const { patchBetween } = require('./patch');
const { relativeTo } = require('./paths');
const { digestOf } = require('./digest');

// How long the renderer gets for an editor command. Longer than a style query,
// because a target read may have to open a page, wait for the preview and walk
// down through three components before it can answer.
const COMMAND_TIMEOUT_MS = 15000;
const NAVIGATING_TIMEOUT_MS = 20000;

const no = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/**
 * Build the API.
 *
 * Everything it needs from the app arrives here as a function, so the whole
 * surface can be exercised in a test with no Electron, no window and no
 * project on disk beyond a temporary folder.
 */
function createAgentApi({
  getProjectRoot = () => null,
  getAgentMode = () => permissions.DEFAULT_MODE,
  callMain = null,
  ask = null,
  readPayload = () => null,
  resolveTrail = () => null,
  version = '0.0.0',
} = {}) {
  const gate = permissions.createGate(getAgentMode);

  const context = () => {
    const payload = readPayload() || null;
    return {
      root: getProjectRoot(),
      callMain: (channel, args) => {
        if (typeof callMain !== 'function') throw new Error('Stacki is not ready.');
        return callMain(channel, args);
      },
      devUrl: payload?.preview?.url || null,
      branch: payload?.project?.branch || null,
      payload,
    };
  };

  // --- refs ------------------------------------------------------------------

  /**
   * A ref for a node, from an anchor.
   *
   * The anchor is the same object a review stores — keys, fingerprint, peer
   * runs, occurrence — so a ref and a review comment are pointing at the same
   * thing in the same way. `writable` is the caller's judgement about the
   * evidence, and the ref carries it rather than re-deriving it later.
   */
  function nodeRef(anchor, { writable = true } = {}) {
    const ctx = context();
    if (!ctx.root || !anchor) return null;
    return refs.mint(
      'node',
      {
        // Trimmed to what re-resolving needs. A creation snapshot belongs on a
        // review, which is a record; a ref is a handle.
        keys: anchor.keys || [],
        fingerprint: anchor.fingerprint || null,
        page: anchor.page || null,
        occurrence: anchor.occurrence ?? null,
        occurrenceCount: anchor.occurrenceCount ?? null,
        instanceOccurrence: anchor.instanceOccurrence ?? null,
        breakpoint: anchor.breakpoint || null,
        // Which tree it was minted against. A ref that survives a branch switch
        // and then resolves on position alone is the failure this stops.
        branch: anchor.branch ?? ctx.branch ?? null,
      },
      { projectRoot: ctx.root, writable }
    );
  }

  /** A ref for a file, as source. */
  function sourceRef(rel) {
    const ctx = context();
    if (!ctx.root || !rel) return null;
    return refs.mint('source', { path: rel }, { projectRoot: ctx.root });
  }

  function readRef(ref, kind) {
    const ctx = context();
    if (!ctx.root) return no('no_project', 'No project is open in Stacki.');
    const parsed = refs.parse(ref, { projectRoot: ctx.root, kind });
    if (!parsed.ok) return parsed;
    return parsed;
  }

  // --- the renderer ----------------------------------------------------------

  async function command(params, timeout = COMMAND_TIMEOUT_MS) {
    if (typeof ask !== 'function') {
      return no('no_window', 'The Stacki window is not available.');
    }
    const answer = await ask('agent', params, timeout);
    if (answer == null) {
      return no(
        'not_ready',
        'The Stacki window did not answer in time. It may be starting a preview or opening a page — try again.'
      );
    }
    return answer;
  }

  // --- evidence --------------------------------------------------------------

  const readFile = (rel) => {
    const ctx = context();
    if (!ctx.root || !rel) return null;
    try {
      return fs.readFileSync(path.resolve(ctx.root, rel), 'utf8');
    } catch {
      return null;
    }
  };

  /**
   * What a write did to the files behind it.
   *
   * Read before and after rather than reasoned about: the model is serialized
   * by Stacki's own writer, and the only honest account of what that produced
   * is what is on disk.
   */
  function changed(files, before) {
    const out = [];
    for (const rel of files) {
      if (!rel) continue;
      const now = readFile(rel);
      const then = before.get(rel) ?? null;
      if (then === null && now === null) continue;
      // Only what actually changed. A file that was watched and came out
      // identical is not a changed file, and listing it invites an agent to
      // wonder what happened to it.
      if (then === now) continue;
      out.push({
        file: rel,
        beforeDigest: then === null ? null : digestOf(then),
        afterDigest: now === null ? null : digestOf(now),
        patch: patchBetween(then ?? '', now ?? ''),
      });
    }
    return out;
  }

  const snapshot = (files) => {
    const before = new Map();
    for (const rel of files) if (rel) before.set(rel, readFile(rel));
    return before;
  };

  /** The files a node ref's edit could land in: the document, and the page. */
  const filesOf = (anchor, extra = []) => {
    const keys = anchor?.keys || [];
    const fromKeys = keys.map((k) => (typeof k === 'string' && k.includes('#') ? k.slice(0, k.indexOf('#')) : null));
    return [...new Set([...fromKeys, anchor?.page?.file || null, ...extra].filter(Boolean))];
  };

  // --- target ----------------------------------------------------------------

  // What the editor's operations actually take.
  //
  // One normalizer, used by both doors. The single-operation actions are the
  // batch with one operation in it, and every one of them goes through here on
  // the way — a prop value written as `"3"` at the protocol and as
  // `{type:'string', value:'3'}` in the model is exactly the sort of thing that
  // is right on one path and `undefined` on the other.
  const propValue = (o) =>
    o.value === undefined || o.value === null
      ? undefined
      : { type: o.valueType === 'expr' ? 'expr' : 'string', value: String(o.value) };

  const NORMALIZE = {
    set_text: (o) => ({ type: 'set_text', value: String(o.value ?? ''), replaceBinding: !!o.replaceBinding }),
    set_prop: (o) => ({ type: 'set_prop', name: o.name, value: propValue(o) }),
    remove_prop: (o) => ({ type: 'remove_prop', name: o.name }),
    set_classes: (o) => ({ type: 'set_classes', classes: o.classes }),
    add_class: (o) => ({ type: 'add_class', className: o.className }),
    remove_class: (o) => ({ type: 'remove_class', className: o.className }),
    insert_before: (o) => ({ type: 'insert_before', node: o.node }),
    insert_after: (o) => ({ type: 'insert_after', node: o.node }),
    append_child: (o) => ({ type: 'append_child', node: o.node }),
    prepend_child: (o) => ({ type: 'prepend_child', node: o.node }),
    remove: () => ({ type: 'remove' }),
    duplicate: () => ({ type: 'duplicate' }),
    // The destination is a ref here and a node id in the renderer; the keys it
    // carries are what crosses, and they are read below.
    move: (o) => ({ type: 'move', to: o.to }),
    set_tag: (o) => ({ type: 'set_tag', tag: o.tag }),
  };

  // The single-operation actions, in their own argument names.
  const SINGLE = {
    set_text: (a) => NORMALIZE.set_text({ value: a.text, replaceBinding: a.replaceBinding }),
    set_prop: (a) => NORMALIZE.set_prop(a),
    remove_prop: (a) => NORMALIZE.remove_prop(a),
    set_classes: (a) => NORMALIZE.set_classes(a),
    add_class: (a) => NORMALIZE.add_class(a),
    remove_class: (a) => NORMALIZE.remove_class(a),
    insert_before: (a) => NORMALIZE.insert_before(a),
    insert_after: (a) => NORMALIZE.insert_after(a),
    append_child: (a) => NORMALIZE.append_child(a),
    remove: () => NORMALIZE.remove({}),
    duplicate: () => NORMALIZE.duplicate({}),
    move: (a) => NORMALIZE.move({ to: a.to }),
    set_tag: (a) => NORMALIZE.set_tag(a),
  };

  async function target(action, args) {
    const ctx = context();
    if (!ctx.root) return no('no_project', 'No project is open in Stacki.');

    let anchor = null;
    let writable = true;
    if (args.ref) {
      const parsed = readRef(args.ref, 'node');
      if (!parsed.ok) return parsed;
      anchor = parsed.data;
      writable = parsed.writable;
    }

    if (action === 'read' || action === 'select' || action === 'enter' || action === 'exit') {
      const answer = await command(
        { domain: 'target', action, anchor, occurrence: args.occurrence, navigate: args.navigate },
        anchor || action === 'enter' || action === 'exit' ? NAVIGATING_TIMEOUT_MS : COMMAND_TIMEOUT_MS
      );
      if (!answer.ok) return answer;
      if (action === 'select') {
        return { ...answer, ref: nodeRef(anchorFromAnswer(answer, ctx), { writable: true }) };
      }
      // enter and exit both answer with a target, and it is a target inside a
      // different file — so it is given the same source trail, snippet and ref
      // a read gets, and the evidence is `exact` because the app just walked
      // there itself.
      return withSource(answer, ctx, action === 'read' ? writable : true);
    }

    if (!SINGLE[action] && action !== 'edit') return no('bad_action', `target has no action "${action}".`);
    if (args.ref && !writable) {
      return no(
        'not_editable',
        'That ref was issued for reading only — Stacki identified the element by position on a tree the ref ' +
          'was not made for. Read the target again on this checkout, or have the person select it.'
      );
    }

    let operations;
    if (action === 'edit') {
      const listed = args.operations || [];
      const unknown = listed.find((op) => !NORMALIZE[op?.type]);
      if (unknown) return no('bad_operation', `"${unknown.type}" is not an operation.`);
      operations = listed.map((op) => NORMALIZE[op.type](op));
    } else {
      operations = [SINGLE[action](args)];
    }
    if (!operations.length) return no('bad_request', 'edit needs at least one operation.');

    // A move names where it is going with a ref. The renderer works in node
    // ids, and a ref is not one — so it is read here, where refs are read, and
    // the keys it carries go across instead.
    for (const op of operations) {
      if (op?.type !== 'move' || !op.to) continue;
      if (op.to.parentRef) {
        const parsed = readRef(op.to.parentRef, 'node');
        if (!parsed.ok) return { ...parsed, message: `The move destination: ${parsed.message}` };
        op.to = { parentKeys: parsed.data.keys || [], index: op.to.index };
      } else {
        op.to = { parentKeys: null, index: op.to.index };
      }
    }

    const watching = filesOf(anchor || currentAnchor(ctx));
    const before = snapshot(watching);
    const answer = await command(
      {
        domain: 'target',
        action: 'edit',
        anchor,
        operations,
        expectedRevision: args.expectedRevision,
        expectedDigest: args.expectedDigest,
        label: action,
      },
      NAVIGATING_TIMEOUT_MS
    );
    if (!answer.ok) return answer;
    const nextAnchor = anchorFromAnswer(answer, ctx, anchor);
    return {
      ok: true,
      action,
      notes: answer.notes || [],
      // A delete leaves nothing to point at, and saying so is better than
      // handing back a ref that will fail on its next use.
      ref: answer.gone ? null : nodeRef(nextAnchor, { writable: true }),
      gone: !!answer.gone,
      revisionBefore: args.expectedRevision ?? null,
      document: answer.document || null,
      changedFiles: changed(watching, before),
      undoable: true,
      preview: {
        note:
          'Stacki has written the change and the preview is rebuilding. Take a capture to verify it before ' +
          'resolving anything.',
      },
    };
  }

  /** The anchor a renderer answer describes, for minting the ref back. */
  function anchorFromAnswer(answer, ctx, previous = null) {
    const payload = ctx.payload;
    return {
      keys: answer.keys || previous?.keys || payload?.selection?.keys || [],
      // The marks as they are NOW. An edit that changed the words would leave
      // a ref describing the words that used to be there, and the next read
      // would find the node on position alone and say so — correct, and a
      // needless downgrade of something we can simply keep current.
      fingerprint: answer.fingerprint || (answer.target ? fingerprintOf(answer.target) : previous?.fingerprint || null),
      page: answer.target?.page || previous?.page || { file: payload?.page?.file || null, route: payload?.page?.route || null },
      occurrence: answer.target?.occurrence?.index ?? previous?.occurrence ?? null,
      occurrenceCount: answer.target?.occurrence?.count ?? previous?.occurrenceCount ?? null,
      instanceOccurrence: previous?.instanceOccurrence ?? payload?.selection?.instanceOccurrence ?? null,
      breakpoint: previous?.breakpoint || null,
      branch: ctx.branch,
    };
  }

  /**
   * The marks a ref re-identifies its node by, from a target read.
   *
   * The same five things a review anchor records, under the same names —
   * src/reviewAnchor.js reads `breadcrumbs` and `peers` off a fingerprint, and
   * a field spelled anything else is a field it never looks at.
   */
  const fingerprintOf = (t) => ({
    nodeKind: t.kind || null,
    tag: t.tag || null,
    text: t.text?.value || null,
    breadcrumbs: t.breadcrumbs || null,
    peers: t.peers || null,
  });

  const currentAnchor = (ctx) => ({
    keys: ctx.payload?.selection?.keys || [],
    page: { file: ctx.payload?.page?.file ? relativeTo(ctx.root, ctx.payload.page.file) : null },
  });

  /**
   * Add what only the main process can say: where the target is in source.
   *
   * The renderer knows the node; the parser and the files are here. So the trail
   * of file:line pointers and the snippet of the markup itself are attached on
   * the way out, which is what makes a target read enough on its own.
   */
  function withSource(answer, ctx, writable) {
    const t = answer.target;
    if (!t) return answer;
    const trail = resolveTrail(t.keys) || [];
    const leaf = trail[trail.length - 1] || null;
    // A ref for each child and for the parent, so walking the tree is reading
    // this answer rather than a round trip per node. Their fingerprints carry
    // what a summary knows — kind, tag, words — which with the position is the
    // same evidence Stacki uses to re-find a node after a reload.
    const near = (summary) =>
      summary && Array.isArray(summary.keys) && summary.keys.length
        ? nodeRef(
            {
              keys: summary.keys,
              fingerprint: {
                nodeKind: summary.kind || null,
                tag: summary.tag || null,
                text: summary.text || null,
                // Without this the ref is only about the slot, and a sibling
                // inserted above it turns "this node" into "whatever is here
                // now" — which the resolver correctly refuses, leaving an
                // agent with a dead ref for a node that plainly still exists.
                breadcrumbs: summary.breadcrumbs || null,
              },
              page: t.page,
              branch: ctx.branch,
            },
            { writable: writable && t.editable !== false }
          )
        : null;
    // A binding that resolves to a prop names the instance that sets it; a
    // binding that resolves to a file names the file. Both become refs here,
    // which is what turns "where do these words come from" into one more call
    // rather than a search.
    const followable = (binding) => {
      const source = binding?.source;
      if (!source) return binding;
      if (source.kind === 'prop' && source.instanceKeys?.length) {
        return {
          ...binding,
          source: {
            ...source,
            instanceRef: nodeRef(
              { keys: source.instanceKeys, fingerprint: null, page: t.page, branch: ctx.branch },
              { writable: true }
            ),
          },
        };
      }
      if (source.kind === 'import' && source.spec) {
        return { ...binding, source: { ...source, resolve: 'Use source.resolve_path or content.resolve_import with this spec.' } };
      }
      return binding;
    };
    return {
      ...answer,
      target: {
        ...t,
        bindings: Array.isArray(t.bindings) ? t.bindings.map(followable) : t.bindings,
        occurrence: t.occurrence?.perOccurrence
          ? { ...t.occurrence, perOccurrence: followable({ source: t.occurrence.perOccurrence }).source }
          : t.occurrence,
        parent: t.parent ? { ...t.parent, ref: near(t.parent) } : null,
        children: Array.isArray(t.children) ? t.children.map((child) => ({ ...child, ref: near(child) })) : null,
        peers: answer.peers || null,
        source: leaf,
        sourceTrail: trail.length ? trail : null,
        snippet: leaf ? snippetOf(ctx.root, leaf) : null,
        ref: nodeRef(
          {
            keys: t.keys,
            fingerprint: fingerprintOf({ ...t, peers: answer.peers }),
            page: t.page,
            occurrence: t.occurrence?.index ?? null,
            occurrenceCount: t.occurrence?.count ?? null,
            breakpoint: null,
            branch: ctx.branch,
          },
          { writable: writable && t.editable !== false }
        ),
        // The file itself, for the cases target cannot express. Named here so
        // an agent never has to work out which file to open.
        sourceRef: leaf?.file ? sourceRef(leaf.file) : null,
      },
      peers: undefined,
    };
  }

  const SNIPPET_PAD = 2;
  const SNIPPET_MAX = 60;

  function snippetOf(root, at) {
    if (!at?.file || at.startLine == null) return null;
    let text;
    try {
      text = fs.readFileSync(path.resolve(root, at.file), 'utf8');
    } catch {
      return null;
    }
    const lines = text.split('\n');
    const from = Math.max(1, at.startLine - SNIPPET_PAD);
    const to = Math.min(lines.length, (at.endLine ?? at.startLine) + SNIPPET_PAD);
    const shown = Math.min(to - from + 1, SNIPPET_MAX);
    return {
      startLine: from,
      endLine: from + shown - 1,
      text: lines.slice(from - 1, from + shown - 1).join('\n'),
      truncated: to - from + 1 > SNIPPET_MAX,
    };
  }

  // --- style -----------------------------------------------------------------

  async function style(action, args) {
    const ctx = context();
    if (!ctx.root) return no('no_project', 'No project is open in Stacki.');
    const op = registry.find('style', action);
    if (!op) return no('bad_action', `style has no action "${action}".`);

    if (op.via === 'main') return runMain('style', action, args, ctx);

    let anchor = null;
    if (args.ref) {
      const parsed = readRef(args.ref, 'node');
      if (!parsed.ok) return parsed;
      anchor = parsed.data;
    }
    if (action === 'read' || action === 'list_sources') {
      const answer = await command({ domain: 'style', action, anchor, properties: args.properties }, NAVIGATING_TIMEOUT_MS);
      if (!answer.ok) return answer;
      return withStyleRefs(answer, ctx);
    }
    // A style write lands in a stylesheet or a <style> block; both are files
    // this process can read either side of the write.
    const watching = filesOf(anchor || currentAnchor(ctx), styleFilesOf(args));
    const before = snapshot(watching);
    const answer = await command({ domain: 'style', action, anchor, ...args, ref: undefined }, NAVIGATING_TIMEOUT_MS);
    if (!answer.ok) return answer;
    const files = [...new Set([...watching, answer.source?.file || null].filter(Boolean))];
    return {
      ...answer,
      changedFiles: changed(files, snapshotMerge(before, files)),
      undoable: true,
      preview: { note: 'Stacki has written the CSS; the preview reloads it. Capture to verify.' },
    };
  }

  // The style keys that travel are already project-relative (see
  // src/agent/styleAgent.js), so this is a slice rather than a resolve — and an
  // older absolute one is turned back into a relative path rather than watched
  // as if it were inside the project.
  const styleFilesOf = (args) => {
    const key = args?.identity?.source || args?.source || '';
    if (typeof key !== 'string' || !(key.startsWith('file:') || key.startsWith('astro:'))) return [];
    const rest = key.slice(key.indexOf(':') + 1);
    return [rest.startsWith('/') ? relativeTo(getProjectRoot(), rest) : rest].filter(Boolean);
  };

  /** Keep the before-image for files we watched, and null for ones we did not. */
  const snapshotMerge = (before, files) => {
    const out = new Map(before);
    for (const f of files) if (!out.has(f)) out.set(f, null);
    return out;
  };

  /** A ref for every authored declaration, so following one takes no search. */
  function withStyleRefs(answer, ctx) {
    if (!Array.isArray(answer.rules)) return answer;
    return {
      ...answer,
      rules: answer.rules.map((rule) => ({
        ...rule,
        sourceRef: rule.source?.file ? sourceRef(rule.source.file) : null,
        declarations: (rule.declarations || []).map((decl) => ({
          ...decl,
          variableRefs: (decl.variables || []).map((name) =>
            refs.mint('cssvar', { name }, { projectRoot: ctx.root })
          ),
        })),
      })),
    };
  }

  /**
   * A main-process operation, and then the editor caught up with it.
   *
   * `source.write` to the page Stacki has open is the case that made this
   * necessary. The model in memory then describes a file that is gone, and
   * nothing tells it: the writer marks its own writes so the watcher does not
   * echo them, which is right for the app's own save and wrong for this. Left
   * alone, the next model save would put the old markup back over the new file
   * and the only evidence would be the work disappearing.
   *
   * So after any write, if the open document's bytes moved, the renderer is
   * asked to take it from disk again — the same reload the watcher does for an
   * outside editor, because that is what this is.
   */
  async function mainWithSync(domain, action, args, ctx, op) {
    if (op.risk === 'read') return runMain(domain, action, args, ctx);
    const openFile = ctx.payload?.page?.file ? relativeTo(ctx.root, ctx.payload.page.file) : null;
    // The open PAGE is what the canvas is showing; the open DOCUMENT may be a
    // component drilled into. Watch both — either changing under the model is
    // the same problem.
    const watching = [...new Set([openFile, ...filesOf(currentAnchor(ctx))].filter(Boolean))];
    const before = snapshot(watching);
    const result = await runMain(domain, action, args, ctx);
    const moved = watching.filter((rel) => (before.get(rel) ?? null) !== readFile(rel));
    if (!moved.length) return result;
    const synced = await command({ domain: 'project', action: 'reload_open_document' }, COMMAND_TIMEOUT_MS);
    return {
      ...result,
      // Said out loud rather than done quietly: reloading the document drops
      // the page's undo snapshots, because they describe a tree that is no
      // longer there.
      editorReloaded: !!synced?.reloaded,
      document: synced?.document || null,
      note: synced?.reloaded
        ? `${moved.join(', ')} is open in Stacki, so the editor took it from disk again. Its undo history for that page is gone — a semantic edit through target would have kept it.`
        : result.note ?? null,
      changedFiles: changed(moved, before),
    };
  }

  // --- capabilities ----------------------------------------------------------

  function capabilities() {
    const ctx = context();
    return {
      ok: true,
      stacki: { version },
      project: ctx.root
        ? { name: path.basename(ctx.root), open: true, branch: ctx.branch, preview: ctx.devUrl ? 'running' : 'not running' }
        : { name: null, open: false, branch: null, preview: 'not running' },
      access: {
        mode: gate.mode,
        label: permissions.LABEL[gate.mode],
        canRead: gate.allows('read'),
        canEdit: gate.allows('write'),
        canDoHighRisk: gate.allows('high'),
        note:
          gate.mode === 'inspect'
            ? 'Read-only. Every project mutation is refused until the person at the keyboard raises this in Stacki’s AI connection window.'
            : gate.mode === 'edit'
              ? 'Ordinary editing is allowed. Destructive and remote operations — git writes, deletes, dependency installs — are refused.'
              : 'Everything Stacki exposes, including destructive and remote git operations.',
      },
      // What there is, and whether this level may run it. Deliberately without
      // the per-action summaries: they are in the tool descriptions the client
      // already has, and repeating a hundred and thirty of them would make the
      // one call an agent makes to orient itself the most expensive call in
      // the surface.
      domains: registry.DOMAINS.map((domain) => ({
        domain,
        actions: registry.actionsOf(domain).map((action) => {
          const op = registry.find(domain, action);
          return { action, risk: op.risk, allowed: gate.allows(op.risk) };
        }),
      })),
      limits: [
        'Refs are scoped to the open project and to this run of Stacki: reopening a project invalidates every one.',
        'Anything Stacki cannot model as a tree (a framework component, a config, plain JS) is readable and writable ' +
          'through the source domain only — the semantic operations report it rather than pretending.',
        'Editing a node inside a loop changes every rendered copy; target.read says so, and points at the data item ' +
          'when it can resolve one.',
        'Nothing here creates review workspaces, invitations or identities, opens native dialogs, runs a shell, or ' +
          'reads outside the open project.',
      ],
    };
  }

  function info() {
    const ctx = context();
    const payload = ctx.payload;
    return {
      ok: true,
      project: { open: !!ctx.root, name: ctx.root ? path.basename(ctx.root) : null, branch: ctx.branch },
      page: { route: payload?.page?.route || null, file: payload?.page?.file ? relativeTo(ctx.root, payload.page.file) : null },
      view: payload?.view || null,
      preview: { status: payload?.preview?.status || 'off' },
      access: { mode: gate.mode, label: permissions.LABEL[gate.mode] },
      agentApi: { version, refSession: refs.session },
    };
  }

  // --- the door --------------------------------------------------------------

  /**
   * Run one operation.
   *
   * `domain` and `action` are what the tool schema accepted; everything else is
   * that action's own arguments. The permission check is here and nowhere else,
   * before anything is dispatched, so there is no path to an operation that
   * skips it.
   */
  async function run(domain, action, args = {}) {
    const op = registry.find(domain, action);
    if (!op) return no('bad_action', `Stacki has no ${domain}.${action}. Call get_capabilities for what it does have.`);

    const denied = gate.check(`${domain}.${action}`, op.risk);
    if (denied) return denied;

    const ctx = context();
    if (!ctx.root && !(domain === 'project' && action === 'info')) {
      return no('no_project', 'No project is open in Stacki. Ask the person to open one.');
    }

    try {
      if (domain === 'target') return await target(action, args);
      if (domain === 'style') return await style(action, args);
      if (domain === 'project' && action === 'info') return info();
      if (op.via === 'renderer') {
        const answer = await command({ domain, action, ...args });
        return answer;
      }
      return await mainWithSync(domain, action, args, ctx, op);
    } catch (err) {
      return no('failed', String(err?.message || err));
    }
  }

  return {
    run,
    capabilities,
    info,
    nodeRef,
    sourceRef,
    readRef,
    get mode() {
      return gate.mode;
    },
  };
}

module.exports = { createAgentApi, COMMAND_TIMEOUT_MS, NAVIGATING_TIMEOUT_MS };
