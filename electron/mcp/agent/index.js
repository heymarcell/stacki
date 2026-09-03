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
const { runMain, resolveContentEntry } = require('./domains');
const { patchBetween } = require('./patch');
const { relativeTo } = require('./paths');
const { digestOf } = require('./digest');

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
  remove: () => ({ type: 'remove' }),
  duplicate: () => ({ type: 'duplicate' }),
  // The destination is a ref here and a node id in the renderer; the keys it
  // carries are what crosses, and they are read below.
  move: (o) => ({ type: 'move', to: o.to }),
  set_tag: (o) => ({ type: 'set_tag', tag: o.tag }),
};

// How long the renderer gets for an editor command. Longer than a style query,
// because a target read may have to open a page, wait for the preview and walk
// down through three components before it can answer.
const COMMAND_TIMEOUT_MS = 15000;
const NAVIGATING_TIMEOUT_MS = 20000;
// Starting a dev server is not a round trip to the window; it is the window
// waiting for Astro to boot, resolve a config and bind a port, and on a cold
// project that is tens of seconds. Under the ordinary command deadline it came
// back `not_ready` while the server was still coming up perfectly well — and
// then really did come up, unowned, with the caller told it had failed.
//
// Stopping one is the same shape for the same reason: asking Astro's CLI,
// signalling the daemon it wrote down, escalating if it will not go, and then
// waiting for the port to actually be released. Answering before that is over
// is what made "stopped" untrue in the first place, so the deadline has to
// allow the work rather than cut it short and call it a timeout.
const DEV_START_TIMEOUT_MS = 180000;
const DEV_STOP_TIMEOUT_MS = 90000;

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
  // WHERE THE PREVIEW REALLY IS.
  //
  // The payload is published from a React effect, so it tells you where the
  // dev server was as of the last render. An agent that starts one and asks
  // about it in the same breath is quicker than that: dev_start answered with
  // a URL and content.sample_entry, one call later, was told there was no
  // preview. Main owns the process and knows the moment it binds, so it is
  // asked first and the payload is the fallback.
  getDevUrl = () => null,
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
      devUrl: getDevUrl() || payload?.preview?.url || null,
      branch: payload?.project?.branch || null,
      payload,
      // The two things the domains need from the ref system: a ref to hand back
      // with a read, and the observation to check a write against.
      sourceRef: (rel) => sourceRef(rel),
      refObservation: (ref, expectedPath) => refObservation(ref, expectedPath),
      // And how text reaches a file, which is not always the same door.
      writeText: (rel, text) => writeProjectText(rel, text),
    };
  };

  /**
   * Put text in a project file.
   *
   * Two doors, and which one it goes through is not the caller's business —
   * it is a fact about what Stacki happens to have open:
   *
   *   the open document   through the EDITOR. `pushHistory`, the state, the
   *                       normal save. The change is on the undo stack, the
   *                       canvas has it, and ⌘Z takes it back. This is the
   *                       whole reason the door exists: writing the file and
   *                       then telling the renderer to re-read it also worked,
   *                       and threw away every page snapshot in the history
   *                       while it did.
   *
   *   any other file      straight to disk. There is no editor state to keep
   *                       in step, and the answer says `undoable: false`
   *                       rather than implying otherwise.
   */
  async function writeProjectText(rel, text) {
    const ctx = context();
    const open = openDocument(ctx);
    if (open && open === rel) {
      const answer = await command({ domain: 'project', action: 'write_open_source', text }, COMMAND_TIMEOUT_MS);
      if (!answer?.ok) {
        return {
          error: answer || no('not_ready', 'The Stacki window did not answer in time.'),
        };
      }
      return {
        through: {
          through: 'editor',
          undoable: true,
          document: answer.document || null,
          note:
            'Stacki has this file open, so the change went through its editor: it is on the canvas and ⌘Z takes ' +
            'it back, along with everything else in the page’s history.',
        },
      };
    }
    await ctx.callMain('src:writeText', { projectPath: ctx.root, rel, text });
    return {
      through: {
        through: 'disk',
        // Honest rather than flattering: nothing in Stacki is holding this
        // file, so nothing in Stacki can take the change back.
        undoable: false,
        note: 'Stacki does not have this file open, so the change went straight to disk and its undo cannot take it back.',
      },
    };
  }

  /** The document the editor is holding, project-relative. */
  function openDocument(ctx) {
    const keys = ctx.payload?.selection?.keys || [];
    const leaf = keys.length ? keys[keys.length - 1] : null;
    if (typeof leaf === 'string' && leaf.includes('#')) return leaf.slice(0, leaf.indexOf('#'));
    return ctx.payload?.page?.file ? relativeTo(ctx.root, ctx.payload.page.file) : null;
  }

  /**
   * What a file ref says it saw, checked against the file it is being used on.
   *
   * A ref names its own path, so a write that passes a ref for one file while
   * naming another is a mistake worth catching rather than a guard worth
   * ignoring — the digest would be about the wrong file, and would probably
   * even match.
   */
  function refObservation(ref, expectedPath) {
    const parsed = readRef(ref, 'source');
    if (!parsed.ok) return { error: parsed };
    const named = parsed.data?.path || null;
    if (expectedPath && named && named !== expectedPath) {
      return {
        error: no(
          'wrong_target',
          `That ref is for ${named}, and this write names ${expectedPath}. Nothing was written.`
        ),
      };
    }
    return { digest: parsed.observed?.digest ?? null, path: named };
  }

  // --- refs ------------------------------------------------------------------

  /**
   * A ref for a node, from an anchor.
   *
   * The anchor is the same object a review stores — keys, fingerprint, peer
   * runs, occurrence — so a ref and a review comment are pointing at the same
   * thing in the same way. `writable` is the caller's judgement about the
   * evidence, and the ref carries it rather than re-deriving it later.
   */
  function nodeRef(anchor, { writable = true, observed = null } = {}) {
    const ctx = context();
    if (!ctx.root || !anchor) return null;
    // AND A WRITE HANDLE HAS TO CARRY WHAT IT SAW.
    //
    // The guard that refuses a stale write compares the ref's observation
    // against the document now, so a ref minted writable with no observation
    // is not a weaker guard — it is no guard at all, and it read as ok:true
    // through every write in the API. Two callers forgot (get_context's ref
    // and a comment focus's), and a third never had one to forget.
    //
    // Degraded rather than thrown: read-only is a first-class, tested state,
    // so a caller that forgets gets a ref that reads and refuses to write
    // instead of an unguarded one. A ref for something with no version to be
    // stale against — a file that does not exist yet — is a different kind and
    // is minted elsewhere.
    const versioned = !!(observed && (observed.revision != null || observed.digest != null));
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
      // What the read that produced this saw. A write through this ref is
      // checked against it, which is what makes concurrency protection
      // something a client cannot forget to ask for.
      { projectRoot: ctx.root, writable: writable && versioned, observed }
    );
  }

  /**
   * The document the app has last published about itself, as an observation.
   *
   * The two refs an agent is handed without asking for a read — the one
   * get_context returns and the one a comment focus returns — are minted out
   * here rather than out of a renderer answer, so this is where the version
   * they saw has to come from. It is the same `document` a read answers with,
   * carried on the payload the window publishes on every render.
   *
   * A payload that is a render behind names an OLDER revision than the truth,
   * and the write through such a ref is refused rather than accepted. That is
   * the direction a lag has to fail in, and it is why this is allowed to read
   * a published fact rather than having to ask the window for a fresh one.
   */
  function publishedDocument() {
    const doc = readPayload()?.document || null;
    if (!doc || (doc.revision == null && doc.digest == null)) return null;
    return doc;
  }

  /**
   * A node ref for something the WINDOW is pointing at, not something a read
   * returned. Same mint, same guard — the observation comes from the payload
   * because there is no answer to take it from.
   */
  function publishedNodeRef(anchor, { writable = true } = {}) {
    return nodeRef(anchor, { writable, observed: publishedDocument() });
  }

  /**
   * A ref for a file, as source.
   *
   * It carries the file's digest, so a write through it is guarded whether or
   * not the caller thought to name one.
   */
  function sourceRef(rel) {
    const ctx = context();
    if (!ctx.root || !rel) return null;
    return refs.mint('source', { path: rel }, { projectRoot: ctx.root, observed: fileObservation(rel) });
  }

  /**
   * The digest of a project file right now, or nothing when there is no file.
   *
   * A CMS path can name an export inside a page — `src/pages/index.astro#plans`
   * — and the thing to read is the file, while the thing to identify is the
   * export. So the fragment is kept on the ref and taken off to read.
   */
  function fileObservation(rel) {
    const text = readFile(String(rel).split('#')[0]);
    return text === null ? null : { digest: digestOf(text), file: rel };
  }

  /**
   * Whether a writable node ref may be used to write at all.
   *
   * The staleness comparison itself is the renderer's — it is the only place
   * that knows what the document is right now — and it is reached by putting
   * the ref's observation on the command. This is the step before that: a
   * writable ref that carries NO observation would send `undefined`, and the
   * renderer's guard is written `if (args.expectedRevision != null && ...)`,
   * so an absent expectation skips the check in silence. That is the whole of
   * how an unguarded write used to happen, and it is why this refuses rather
   * than letting the absence mean "no objection".
   *
   * `null` when there is nothing to object to. There was a function of this
   * name here before that was never called from anywhere; this is the same
   * question, asked.
   */
  function requireObservation(parsed) {
    if (!parsed?.ok || parsed.kind !== 'node' || parsed.writable !== true) return null;
    const seen = parsed.observed;
    if (seen && (seen.revision != null || seen.digest != null)) return null;
    return no(
      'bad_ref',
      'That ref was issued without a record of the version it saw, so a write through it could not be checked ' +
        'against the document. Read the target again and use the ref that read hands back.'
    );
  }

  /**
   * What a write must prove about the document, from the ref and the caller.
   *
   * THE REF WINS. It used to be `args.expectedRevision ?? seen.observed.revision`,
   * which put the CLIENT'S value first — so the same stale ref was refused
   * with no arguments and accepted with two, and a guard a caller can switch
   * off by naming any current number is not a guard. The file path has always
   * done it the other way round (domains.js: `expected = fromRef.digest ?? expected`),
   * and these are two halves of one surface.
   *
   * An explicit expectation is still honoured — it is the only expectation
   * there is for a call with no ref, which acts on the live selection — and
   * where a call carries both, a DISAGREEMENT is refused rather than silently
   * resolved either way. That can only ever add a refusal.
   */
  function expectationsFor(args, seen) {
    const observed = seen?.observed || null;
    if (
      args.expectedRevision != null &&
      observed?.revision != null &&
      args.expectedRevision !== observed.revision
    ) {
      return {
        error: no(
          'bad_request',
          `That ref saw revision ${observed.revision} and you named ${args.expectedRevision}. ` +
            'Drop the argument, or read the target again and use the ref that read hands back.'
        ),
      };
    }
    if (args.expectedDigest != null && observed?.digest != null && args.expectedDigest !== observed.digest) {
      return {
        error: no(
          'bad_request',
          'That ref saw a different version of the document than the digest you named. ' +
            'Drop the argument, or read the target again and use the ref that read hands back.'
        ),
      };
    }
    return {
      expectedRevision: observed?.revision ?? args.expectedRevision,
      expectedDigest: observed?.digest ?? args.expectedDigest,
    };
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
    let seen = null;
    if (args.ref) {
      const parsed = readRef(args.ref, 'node');
      if (!parsed.ok) return parsed;
      anchor = parsed.data;
      writable = parsed.writable;
      seen = parsed;
    }

    if (action === 'read' || action === 'select' || action === 'enter' || action === 'exit') {
      const answer = await command(
        { domain: 'target', action, anchor, occurrence: args.occurrence, navigate: args.navigate },
        anchor || action === 'enter' || action === 'exit' ? NAVIGATING_TIMEOUT_MS : COMMAND_TIMEOUT_MS
      );
      if (!answer.ok) return answer;
      if (action === 'select') {
        return {
          ...answer,
          // WITH THE MARKS THE INCOMING REF CARRIED. Minted without them this
          // was a bare index path plus an observation — safe only for as long
          // as nothing moved, which is not what a ref is for.
          //
          // Writable on the renderer's judgement rather than on the caller's:
          // selecting re-resolves the node in the tree that is actually open
          // and re-derives the same evidence rule a pin is drawn under, so a
          // node it could not vouch for does not become writable by being
          // selected. Strictly narrower than the `writable: true` this used to
          // pass unconditionally.
          ref: nodeRef(anchorFromAnswer(answer, ctx, anchor), {
            writable: answer.writable !== false,
            observed: answer.document || null,
          }),
        };
      }
      // enter and exit both answer with a target, and it is a target inside a
      // different file — so it is given the same source trail, snippet and ref
      // a read gets, and the evidence is `exact` because the app just walked
      // there itself.
      return withSource(answer, ctx, action === 'read' ? writable : true, { compact: args?.compact === true });
    }

    if (!SINGLE[action] && action !== 'edit') return no('bad_action', `target has no action "${action}".`);
    if (args.ref && !writable) {
      return no(
        'not_editable',
        'That ref was issued for reading only — Stacki identified the element by position on a tree the ref ' +
          'was not made for. Read the target again on this checkout, or have the person select it.'
      );
    }
    const unobserved = requireObservation(seen);
    if (unobserved) return unobserved;

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

    // The ref's own observation is the guard, and it is not optional: it was
    // baked in by the read that handed the ref over, and it wins over anything
    // the caller names. A call with NO ref acts on the live selection, which is
    // by definition what is in front of the person right now — there is no
    // earlier observation for it to be stale against, and an explicit
    // expectation is then the only one there is.
    const expected = expectationsFor(args, seen);
    if (expected.error) return expected.error;

    const watching = filesOf(anchor || currentAnchor(ctx));
    const before = snapshot(watching);
    const answer = await command(
      {
        domain: 'target',
        action: 'edit',
        anchor,
        operations,
        expectedRevision: expected.expectedRevision,
        expectedDigest: expected.expectedDigest,
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
      ref: answer.gone ? null : nodeRef(nextAnchor, { writable: true, observed: answer.document || null }),
      gone: !!answer.gone,
      // Both sides of the change, so the next write can name this one without
      // a second read.
      revisionBefore: answer.documentBefore?.revision ?? expected.expectedRevision ?? null,
      revisionAfter: answer.document?.revision ?? null,
      documentBefore: answer.documentBefore || null,
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
      // Project-relative, like every other reader of this field — `payload.page.file`
      // is an on-disk path, and this arm was the one place it went into a ref
      // as one. refs.mint now catches it as well; this is where it stops being
      // wrong rather than merely being caught.
      page: answer.target?.page ||
        previous?.page || {
          file: payload?.page?.file ? relativeTo(ctx.root, payload.page.file) : null,
          route: payload?.page?.route || null,
        },
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
    // The words, but only when they are ALL the words. A clipped reading is a
    // preview; the resolver compares a fingerprint's text against a node's full
    // text, so recording a preview records something no node can equal. The
    // breadcrumbs and the peer runs are what identify it in that case, and they
    // are evidence rather than a string that cannot match.
    text: t.text?.truncated ? null : t.text?.value || null,
    breadcrumbs: t.breadcrumbs || null,
    peers: t.peers || null,
  });

  /**
   * The marks for a component instance nobody read.
   *
   * A binding's instance lives in the document above this one, and this process
   * is not holding that tree — so there is nothing to fingerprint it from
   * except the key chain, which is enough for the one thing that matters. The
   * chain is `[page#path, Component.astro#path, ...]`; the instance at
   * `instanceKeys` is the door into the NEXT file in it, so the component it
   * opens is that file's name. That is exactly what a review's drill step
   * checks (`opens` in src/reviewFocus.js), spelled the same way, and it is
   * what stops the index path resolving to whatever was inserted above it.
   */
  function instanceFingerprint(keys, instanceKeys) {
    const chain = Array.isArray(keys) ? keys : [];
    const depth = Array.isArray(instanceKeys) ? instanceKeys.length : 0;
    const next = typeof chain[depth] === 'string' ? chain[depth] : null;
    const file = next && next.includes('#') ? next.slice(0, next.indexOf('#')) : null;
    const name = file ? (file.split('/').pop() || '').replace(/\.(astro|md|mdx)$/i, '') : null;
    return name ? { nodeKind: 'component', tag: name } : null;
  }

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
  function withSource(answer, ctx, writable, { compact = false } = {}) {
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
                // The preview only when it is the whole reading — see
                // fingerprintOf. A child with more than a summary's worth of
                // words and a same-tag sibling was unresolvable on the very
                // next call because this stored the ellipsised version.
                text: summary.textClipped ? null : summary.text || null,
                // Without these the ref is only about the slot, and a sibling
                // inserted above it turns "this node" into "whatever is here
                // now" — which the resolver correctly refuses, leaving an
                // agent with a dead ref for a node that plainly still exists.
                breadcrumbs: summary.breadcrumbs || null,
                peers: summary.peers || null,
              },
              page: t.page,
              branch: ctx.branch,
            },
            { writable: writable && t.editable !== false, observed: answer.document || null }
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
              {
                keys: source.instanceKeys,
                // WHICH COMPONENT THAT SLOT IS EXPECTED TO OPEN.
                //
                // This was `null`, which made the ref a bare index path: with
                // no kind and no tag src/reviewAnchor.js's sameSort matches
                // anything, so inserting an <hr> above the <Hero> this named
                // turned it into a ref for the <hr> — at confidence `exact`.
                // Measured: it wrote a prop onto the <hr>.
                //
                // The key chain says which file the instance opens, and a
                // component named by the file it opens is not a second idea of
                // identity — it is the same check a review's drill step makes
                // (src/reviewFocus.js's `opens`).
                fingerprint: instanceFingerprint(t.keys, source.instanceKeys),
                page: t.page,
                branch: ctx.branch,
              },
              // The instance lives in the page, which is a DIFFERENT document
              // from the one this read was of — there is no observation here to
              // give it, so this is a pointer to GO THERE rather than a handle
              // to write through. `target.select { ref }` navigates to the page,
              // puts the instance in front of the person and hands back a ref
              // with the marks, the observation and the permission a write
              // needs; `target.read { ref }` follows it without changing what
              // is selected, and inherits the caution.
              { writable: false }
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
        // The markup around the target, unless the caller said not to. Walking a
        // tree asks for a node's parent, then its parent, and each answer
        // carries a snippet of the same region: six levels of one page measured
        // 81KB with 17KB of it the same markup five times. `snippetOmitted`
        // rather than a bare null, so "you did not ask" is distinguishable from
        // "there is no source for this".
        snippet: compact || !leaf ? null : snippetOf(ctx.root, leaf),
        ...(compact && leaf ? { snippetOmitted: true } : {}),
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
          // The document as this read found it. A write through this ref is
          // refused if anybody has touched the document since — including when
          // the node itself still resolves perfectly, which is the case that
          // matters: "the right node" and "the version I reasoned about" are
          // different facts.
          { writable: writable && t.editable !== false, observed: answer.document || null }
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

    // Through the same door as every other main-process write, so a variable
    // edit lands on the undo stack and a stylesheet the editor has open is
    // taken from disk again.
    if (op.via === 'main') return mainWithSync('style', action, args, ctx, op);

    // THE SAME THREE THINGS TARGET TAKES OFF A REF, because a ref may only ever
    // become more restrictive as it travels. This took `parsed.data` and dropped
    // `writable` and `observed` on the floor, so a node ref the Visual Review
    // evidence rules had deliberately withheld write permission from wrote
    // `gap: 4rem` into a stylesheet. Measured; the identical ref was correctly
    // refused by target one line of code away.
    let anchor = null;
    let writable = true;
    let seen = null;
    if (args.ref) {
      const parsed = readRef(args.ref, 'node');
      if (!parsed.ok) return parsed;
      anchor = parsed.data;
      writable = parsed.writable;
      seen = parsed;
    }
    if (action === 'read' || action === 'list_sources') {
      const answer = await command({ domain: 'style', action, anchor, properties: args.properties }, NAVIGATING_TIMEOUT_MS);
      if (!answer.ok) return answer;
      return withStyleRefs(answer, ctx);
    }
    if (args.ref && !writable) {
      return no(
        'not_editable',
        'That ref was issued for reading only — Stacki identified the element by position on a tree the ref ' +
          'was not made for. Read the target again on this checkout, or have the person select it.'
      );
    }
    const unobserved = requireObservation(seen);
    if (unobserved) return unobserved;
    // For an external stylesheet this observation is about the .astro file
    // rather than the CSS, and styleAgent has its own source-digest guard for
    // the declaration itself. It is the <style> block in the open document that
    // this is the guard for — and the writable flag above matters in every case.
    const expected = expectationsFor(args, seen);
    if (expected.error) return expected.error;

    // A style write lands in a stylesheet or a <style> block; both are files
    // this process can read either side of the write.
    const watching = filesOf(anchor || currentAnchor(ctx), styleFilesOf(args));
    const before = snapshot(watching);
    const answer = await command(
      {
        domain: 'style',
        action,
        anchor,
        ...args,
        ref: undefined,
        expectedRevision: expected.expectedRevision,
        expectedDigest: expected.expectedDigest,
      },
      NAVIGATING_TIMEOUT_MS
    );
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
          // A name, not a handle: no operation takes a cssvar ref, and minting
          // it writable said otherwise.
          variableRefs: (decl.variables || []).map((name) =>
            refs.mint('cssvar', { name }, { projectRoot: ctx.root, writable: false })
          ),
        })),
      })),
    };
  }

  /**
   * An undo says which files it put back; this says what is in them now.
   *
   * The renderer is the only thing that knows which entry came off the stack,
   * and this process is the only thing that can read a file — so the two halves
   * meet here. The digest is sha256 of the bytes, the same `digestOf` that
   * stamps `changedFiles`, and it is deliberately a different KIND of thing
   * from `document.modelDigest` beside it: content-addressed, so a caller can
   * check a restore against a digest it took before the change.
   *
   * There is no `beforeDigest` here and it is not missing by accident: which
   * files an undo will touch is not knowable until it has touched them, so a
   * before-image would have to be a guess. What this proves is what the files
   * hold now, which is what a restore is a claim about.
   */
  function withRestoreEvidence(answer) {
    const files = answer?.restored?.files;
    if (!answer?.ok || !Array.isArray(files) || !files.length) return answer;
    return {
      ...answer,
      restored: {
        ...answer.restored,
        files: files.map((file) => {
          const text = readFile(file);
          return { file, contentDigest: text === null ? null : digestOf(text) };
        }),
      },
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
    // Two different lists, for two different questions.
    //
    //   `editing` is what the editor is holding — the page on the canvas and
    //   the document drilled into. If one of those moves under the model, the
    //   model has to be taken from disk again.
    //
    //   `named` is what this operation says it is about. That is what an undo
    //   command puts back, and it is deliberately not the same list: a
    //   stylesheet edit that changed no open document still wants an undo, and
    //   reloading the editor for it would be pointless churn.
    const editing = [...new Set([openFile, ...filesOf(currentAnchor(ctx))].filter(Boolean))];
    const named = [...new Set((await touchedBy(domain, action, args, ctx)).filter(Boolean))];
    const watching = [...new Set([...editing, ...named])];
    const before = snapshot(watching);
    const result = await runMain(domain, action, args, ctx);
    const undone = result.ok === false ? false : await recordUndo(domain, action, args, ctx, op, before, named.length ? named : watching);
    const moved = watching.filter((rel) => (before.get(rel) ?? null) !== readFile(rel));
    const reloadNeeded = editing.some((rel) => moved.includes(rel));
    if (!moved.length) return { ...result, ...(op.undoable ? { undoable: undone } : {}) };
    if (!reloadNeeded) {
      return { ...result, ...(op.undoable ? { undoable: undone } : {}), changedFiles: changed(moved, before) };
    }
    const synced = await command({ domain: 'project', action: 'reload_open_document' }, COMMAND_TIMEOUT_MS);
    return {
      ...result,
      ...(op.undoable ? { undoable: undone } : {}),
      // Said out loud rather than done quietly: reloading the document drops
      // the page's undo snapshots, because they describe a tree that is no
      // longer there.
      editorReloaded: !!synced?.reloaded,
      document: synced?.document || null,
      note: synced?.reloaded
        ? `${editing.filter((rel) => moved.includes(rel)).join(', ')} is open in Stacki, so the editor took the file from disk again — the model, the canvas and the file agree.`
        : result.note ?? null,
      changedFiles: changed(moved, before),
    };
  }

  /**
   * Which files an operation is about, so a change to one can be put back.
   *
   * Named rather than discovered: a CSS variable edit can touch several
   * stylesheets, and reading the whole project before and after every write to
   * find out which would cost more than the write.
   */
  async function touchedBy(domain, action, args, ctx) {
    if (domain === 'style') {
      if (action === 'write_source') return [args.path];
      // A variable edit reaches whichever stylesheets declare the names it
      // touches; the variables read says which files those are.
      return VARIABLE_ACTIONS.has(action) ? styleVariableFiles(ctx) : [];
    }
    if (domain === 'content' && action === 'cms_write') {
      const raw = String(args.path || '');
      return [raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw];
    }
    // The file is not the caller's to name any more: write_entry resolves the
    // entry itself from `collection` and `id` (see domains.js), and the undo
    // stack has to snapshot the file the write will actually land in. The
    // resolution is memoised on this context, so asking here does not walk the
    // collection a second time.
    if (domain === 'content' && action === 'write_entry') {
      const found = await resolveContentEntry(args, ctx);
      return found.error ? [] : [found.entry.file];
    }
    return [];
  }

  const VARIABLE_ACTIONS = new Set([
    'set_variable', 'add_variables', 'rename_variables', 'move_variables',
    'add_section', 'set_section_title', 'remove_section', 'move_heading',
  ]);

  /** The stylesheets that declare custom properties. Read once per write. */
  function styleVariableFiles(ctx) {
    try {
      const cssVars = require('../../cssVars');
      return (cssVars.readVariables(ctx.root)?.files || []).map((f) => f.rel);
    } catch {
      return [];
    }
  }

  /**
   * Put a main-process write on the app's own undo stack.
   *
   * Only for the operations the panels make undoable, and only with the inverse
   * the panels use. A content change is the bytes put back; a rename or a move
   * is itself read backwards. Anything that does not fit one of those is not
   * recorded, because a half-inverse on an undo stack is worse than a gap in it.
   */
  async function recordUndo(domain, action, args, ctx, op, before, watching) {
    if (!op.undoable) return false;
    let restore = null;
    if (domain === 'asset' && action === 'rename') {
      const dir = String(args.path).slice(0, String(args.path).lastIndexOf('/'));
      const landed = dir ? `${dir}/${args.name}` : args.name;
      restore = {
        kind: 'asset_rename',
        back: { rel: landed, name: String(args.path).slice(String(args.path).lastIndexOf('/') + 1) },
        forward: { rel: args.path, name: args.name },
      };
    } else if (domain === 'asset' && action === 'move') {
      const name = String(args.path).slice(String(args.path).lastIndexOf('/') + 1);
      const fromDir = String(args.path).slice(0, String(args.path).lastIndexOf('/'));
      const landed = args.toFolder ? `${args.toFolder}/${name}` : name;
      restore = {
        kind: 'asset_move',
        back: { fromRel: landed, toDirRel: fromDir },
        forward: { fromRel: args.path, toDirRel: args.toFolder },
      };
    } else {
      // A content change: the bytes, for every file that actually moved and
      // existed on both sides. A file that appeared or vanished is not a
      // content change and has no bytes-inverse.
      const files = {};
      for (const rel of watching) {
        const then = before.get(rel) ?? null;
        const now = readFile(rel);
        if (then === null || now === null || then === now) continue;
        files[rel] = { before: then, after: now };
      }
      if (!Object.keys(files).length) return false;
      restore = { kind: 'files', files };
    }
    const answer = await command(
      {
        domain: 'project',
        action: 'record_undo',
        label: `${domain}.${action}`,
        // One step per burst, the way a slider drag is one step.
        coalesceKey: `agent:${domain}.${action}`,
        restore,
      },
      COMMAND_TIMEOUT_MS
    );
    return !!answer?.undoable;
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
        // What this level actually authorises, in the same words the window
        // shows the person who granted it.
        grants: permissions.BLURB[gate.mode],
        canRead: gate.allows('read'),
        canEdit: gate.allows('write'),
        canDoHighRisk: gate.allows('high'),
        // WHICH LEVEL WOULD ALLOW THE THING THAT WAS JUST REFUSED, BY NAME.
        //
        // Every action below carries `risk` and `allowed`. Turning "this is a
        // write and it is not allowed" into "you would need Edit project" took
        // a mapping that lived only inside `permissions.refusal()`, and a
        // refusal is a thing an agent only sees if it tries. One that orients
        // itself first -- which is what the instructions tell it to do -- never
        // sees one.
        //
        // Measured: asked to make an edit at `visual`, a real Claude Code
        // called `get_capabilities` once, correctly reported that it could not,
        // correctly said only the person at the keyboard could change it, and
        // named the level needed as "Editing". There is no level called
        // Editing. It had nothing to read the name off, so it made one up --
        // and a person told to look for "Editing" in a window whose control
        // says "Edit project" is a person given a slightly wrong instruction.
        //
        // `permissions.NEEDED` has held this mapping the whole time.
        needs: Object.fromEntries(
          Object.entries(permissions.NEEDED).map(([risk, mode]) => [risk, { mode, label: permissions.LABEL[mode] }])
        ),
        // And every level there is, in order, so "raise it" names something.
        levels: permissions.MODES.map((mode) => ({ mode, label: permissions.LABEL[mode] })),
        // Levels are granted per project, and the one that is not remembered
        // says so — an agent that knows `full` is for this session will not
        // assume it still has it tomorrow.
        scope: 'project',
        sessionOnly: gate.mode === permissions.SESSION_ONLY,
        note:
          gate.mode === 'visual'
            ? 'Visual only, which is what this endpoint did before it could touch the project: get_context, capture, ' +
              'get_comments and comment work; every domain tool below is refused until the person at the keyboard ' +
              'raises this in Stacki’s AI connection window, for this project.'
            : gate.mode === 'inspect'
              ? 'Read-only. Every project mutation is refused until the person at the keyboard raises this.'
              : gate.mode === 'edit'
                ? 'Ordinary editing is allowed. Destructive and remote operations — git writes, deletes, dependency installs — are refused.'
                : 'Everything Stacki exposes, including destructive and remote git operations. Granted for this session and this project.',
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
        'Agent access is granted per project and starts at "Visual only". A grant made on one project does not follow ' +
          'Stacki into the next, and "Full control" lasts only until Stacki quits.',
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
      // EVERY WRITE ANSWERS THE UNDO QUESTION, on the way out and in one place.
      return sayUndoable(op, await dispatch(domain, action, args, ctx, op));
    } catch (err) {
      return no('failed', String(err?.message || err));
    }
  }

  /**
   * Whether Stacki's own undo reaches this write.
   *
   * The field used to be attached only where the registry said `undoable`, so
   * 32 of the 63 write and high operations said nothing at all — while the
   * field's own description reads "False is honest, not an omission" and the
   * docs promise an agent is not left guessing. An absent boolean IS the
   * guessing. A dispatcher that has already worked out whether an undo was
   * really recorded keeps its answer; everything else gets the registry's.
   */
  const sayUndoable = (op, answer) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
    if (op.risk === 'read' || answer.ok === false) return answer;
    if (typeof answer.undoable === 'boolean') return answer;
    return { ...answer, undoable: !!op.undoable };
  };

  /** Where an operation is actually carried out. */
  async function dispatch(domain, action, args, ctx, op) {
    if (domain === 'target') return await target(action, args);
    if (domain === 'style') return await style(action, args);
    if (domain === 'project' && action === 'info') return info();
    if (op.via === 'renderer') {
      // A ref becomes an anchor before it crosses, the same way target and
      // style do it above. The window resolves anchors against its own live
      // model; it has never been handed a raw `ref` string to make sense of,
      // so an operation that took one silently saw nothing at all.
      //
      // AND IT CARRIES WHAT THE REF SAYS. The first version of this took
      // `parsed.data` and dropped the rest, which quietly made a renderer
      // write weaker than the identical target write beside it: a ref minted
      // read-only would have been honoured for target.edit and ignored here,
      // and a ref that had gone stale would have created a component file
      // against a document it never saw. A ref may only ever become MORE
      // restrictive as it travels.
      let anchor = null;
      let refWritable = true;
      let seen = null;
      if (args.ref) {
        const parsed = readRef(args.ref, 'node');
        if (!parsed.ok) return parsed;
        anchor = parsed.data;
        refWritable = parsed.writable;
        seen = parsed;
      }
      // Refused HERE, before the window is asked to do anything, so a
      // read-only ref cannot write a file and then be told off.
      if (args.ref && !refWritable && op.risk !== 'read') {
        return no(
          'not_editable',
          'That ref was issued for reading only — Stacki identified the element by position on a tree the ref ' +
            'was not made for. Read the target again on this checkout, or have the person select it.'
        );
      }
      let expected = { expectedRevision: args.expectedRevision, expectedDigest: args.expectedDigest };
      if (op.risk !== 'read') {
        const unobserved = requireObservation(seen);
        if (unobserved) return unobserved;
        // The ref's own observation is the guard, exactly as it is for
        // target.edit: it was baked in by the read that handed the ref over,
        // the caller does not have to repeat it, and naming a different one
        // does not overrule it.
        expected = expectationsFor(args, seen);
        if (expected.error) return expected.error;
      }
      const answer = await command(
        {
          domain,
          action,
          ...args,
          anchor,
          ref: undefined,
          expectedRevision: expected.expectedRevision,
          expectedDigest: expected.expectedDigest,
        },
        action === 'dev_start' ? DEV_START_TIMEOUT_MS : action === 'dev_stop' ? DEV_STOP_TIMEOUT_MS : NAVIGATING_TIMEOUT_MS
      );
      return withRestoreEvidence(answer);
    }
    return await mainWithSync(domain, action, args, ctx, op);
  }

  return {
    run,
    capabilities,
    info,
    nodeRef,
    publishedNodeRef,
    publishedDocument,
    sourceRef,
    readRef,
    // THE SAME GATE, FOR THE ONE CALLER THAT IS NOT AN OPERATION.
    //
    // `audit` is a top-level tool rather than a registry operation, so that the
    // 111 operations and the 444 permission answers stay exactly what Phase A
    // proved them to be. That leaves it outside `run`, which is where the gate
    // lives -- and a new surface that reads the project without asking the gate
    // is precisely how a `visual` token ends up reading a repository.
    //
    // So it asks the SAME gate object, through this. Not a second check that
    // resembles the first: the first one, called from one more place. It returns
    // the refusal envelope, or null when the level allows it.
    checkAccess: (operation, risk) => gate.check(operation, risk),
    get mode() {
      return gate.mode;
    },
  };
}

// EXPORTED SO THE TABLE CAN BE COMPARED WITH THE OTHER TWO THAT DESCRIBE THE
// SAME SET. `prepend_child` lived here for a while with no counterpart in the
// batch `Operation` union or the registry — implemented, dispatched, and
// reachable by no client. Nothing checked that the three agreed, so the
// discrepancy was invisible; test/schema-dispatch-contract.js now does.
module.exports = { createAgentApi, NORMALIZE, COMMAND_TIMEOUT_MS, NAVIGATING_TIMEOUT_MS, DEV_START_TIMEOUT_MS, DEV_STOP_TIMEOUT_MS };
