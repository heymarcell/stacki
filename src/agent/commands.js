// The door an agent's editor commands come through.
//
// The MCP server lives in the main process and the editor lives here, so
// something has to carry a question across. That something is deliberately
// small and deliberately not general: it is a fixed set of named commands over
// a fixed set of the app's own operations, not a way to reach into React.
//
// Everything it does, it does through what App already has — `mutateModel`,
// `setSelectedId`, the review focus, the undo stack. That is the whole point:
// an agent's edit is not a parallel path into the document, it is the same
// path a click takes. So it lands on the undo stack, it saves through the
// normal writer, it shows up on the canvas, and the person watching can press
// ⌘Z and have it come back.
//
// `app` is a bundle App hands over — read through a getter rather than
// captured, because every field of it is React state that has moved on by the
// time an agent asks.

import { readTarget } from './targetRead.js';
import * as styleAgent from './styleAgent.js';
import { applyOperations, findNodeById } from '../modelOps.js';
import { resolveNode, anchorSteps } from '../reviewAnchor.js';
import { textOf } from '../mcpContext.js';

const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/** Which file a node ref's leaf lives in, and where in it. */
function leafOf(anchor) {
  const steps = anchorSteps(anchor);
  return steps.length ? steps[steps.length - 1] : null;
}

/**
 * Put a target in front of the editor and answer with the node.
 *
 * A node ref IS a review anchor — same keys, same fingerprint, same peer runs —
 * so getting to one is the operation Visual Review already has: open the page,
 * set the breakpoint, walk down through the components, resolve the node. There
 * is no second idea of "go to this element", and there must not be: the
 * evidence rules that decide whether a review may draw a pin are the same ones
 * that decide whether an agent may write here.
 */
async function locate(app, anchor, { navigate = true } = {}) {
  const leaf = leafOf(anchor);
  if (!leaf) return fail('bad_ref', 'That ref carries no position.');

  // Already looking at it: resolve in the tree in hand, which is the only tree
  // whose node ids this app is holding.
  const open = app.openFile();
  if (open === leaf.file) {
    const found = resolveNode(app.model()?.nodes || [], leaf.indexPath, anchor?.fingerprint, {
      labelOf: app.crumbLabel,
    });
    if (found.id) {
      return { ok: true, id: found.id, trail: found.trail, confidence: found.confidence, navigated: false };
    }
    if (!navigate) return fail('no_node', `That element is not in ${leaf.file} any more.`, { reason: found.reason });
  }
  if (!navigate) {
    return fail('not_open', `That element is in ${leaf.file}, which Stacki does not have open.`);
  }

  const moved = await app.focusAnchor(anchor);
  if (!moved || moved.anchorState !== 'attached') {
    return fail(moved?.transient ? 'not_ready' : 'no_node', moved?.note || 'Stacki could not get to that element.', {
      restored: moved?.restored || null,
    });
  }
  const found = resolveNode(app.model()?.nodes || [], leafOf({ ...anchor, keys: moved.keys })?.indexPath, anchor?.fingerprint, {
    labelOf: app.crumbLabel,
  });
  if (!found.id) return fail('no_node', 'Stacki navigated there and then could not find the element.');
  return {
    ok: true,
    id: found.id,
    trail: found.trail,
    confidence: moved.confidence || found.confidence,
    writable: moved.writable,
    navigated: true,
    keys: moved.keys,
    note: moved.note || null,
  };
}

/** One target, read. Shared by read, enter and exit, which all answer with one. */
function readAt(a, node, { confidence = 'exact', writable = true } = {}) {
  const id = node.id;
  return {
    target: readTarget({
      node,
      model: a.model(),
      page: a.page(),
      keys: a.keysFor(id),
      editable: a.editable(),
      crumbLabel: a.crumbLabel,
      keysFor: a.keysFor,
      crumbsFor: a.crumbsFor,
      canvas: id === a.selectedId() ? a.canvas() : null,
      renderedClasses: id === a.selectedId() ? a.renderedClasses() : null,
      componentChain: a.componentChain(),
      breadcrumbs: a.crumbsFor(id),
      hidden: a.isHidden(id),
      inert: a.isInert(id),
      confidence,
      writable,
    }),
    peers: a.peersFor(id),
  };
}

/** The document's identity right now — what a write names to prove it is current. */
function documentOf(app) {
  return { file: app.openFile(), revision: app.revision(), digest: app.digest() };
}

/**
 * The whole command surface. One object, one switch, no dynamic lookup into
 * anything the app happens to expose.
 */
export function createAgentCommands(getApp) {
  // Every property read goes back to the app's current bundle.
  //
  // Not a nicety. A command awaits — a navigation, a save, a canvas settling —
  // and React re-renders underneath it with new state in a new bundle. A
  // reference captured before the await would answer with the model that was
  // open when the command started, which after `enter` is the wrong file
  // entirely. This is one line and it removes the whole class.
  const live = new Proxy(
    {},
    {
      get: (_t, key) => {
        const value = getApp()?.[key];
        return typeof value === 'function' ? value.bind(getApp()) : value;
      },
    }
  );
  const app = () => live;

  async function target(action, args) {
    const a = app();
    if (!a.project()) return fail('no_project', 'No project is open in Stacki.');

    // No ref means the live selection, which is the strongest evidence there
    // is: it is what the person is looking at.
    const live = !args.anchor;
    const anchor = args.anchor || null;

    let id = a.selectedId();
    let confidence = 'exact';
    let writable = true;
    let navigated = false;
    let note = null;
    if (!live) {
      const at = await locate(a, anchor, { navigate: action !== 'read' || args.navigate !== false });
      if (!at.ok) return at;
      id = at.id;
      confidence = at.confidence;
      writable = at.writable === undefined ? a.writableFor(anchor, at.confidence) : at.writable;
      navigated = at.navigated;
      note = at.note;
    } else if (!id) {
      return fail('no_selection', 'Nothing is selected in Stacki, and no ref was given.');
    }

    if (action === 'select') {
      a.select(id, args.occurrence);
      return { ok: true, selected: true, navigated, note, document: documentOf(a), keys: a.keysFor(id) };
    }

    // Going inside a component instance, and coming back out — the two
    // navigations a person makes by double-clicking and pressing Escape. An
    // agent needs them for the same reason: a component's own markup is in its
    // own file, and nothing in the page's tree reaches it.
    if (action === 'enter') {
      const model = a.model();
      const node = findNodeById(model?.nodes || [], id);
      if (!node) return fail('no_node', 'That element is not in the open file any more.');
      if (node.kind !== 'component' || node.dynamicTag) {
        return fail('not_component', `<${node.name || node.kind}> is not a component instance, so there is nothing to open.`);
      }
      const entered = await a.enter(id, args.occurrence);
      if (!entered.ok) return entered;
      const inside = findNodeById(a.model()?.nodes || [], entered.id);
      if (!inside) return fail('not_ready', `Stacki opened <${node.name}> but its tree is not loaded yet. Try again.`);
      return { ok: true, entered: node.name, ...readAt(a, inside), document: documentOf(a), keys: a.keysFor(entered.id) };
    }
    if (action === 'exit') {
      const left = await a.exit();
      if (!left.ok) return left;
      const inside = findNodeById(a.model()?.nodes || [], a.selectedId());
      return {
        ok: true,
        exited: true,
        ...(inside ? readAt(a, inside) : {}),
        document: documentOf(a),
        keys: a.keysFor(a.selectedId()),
      };
    }

    const model = a.model();
    const node = findNodeById(model?.nodes || [], id);
    if (!node) return fail('no_node', 'That element is not in the open file any more.');

    if (action === 'read') {
      return {
        ok: true,
        ...readAt(a, node, { confidence, writable }),
        document: documentOf(a),
        navigated,
        note,
      };
    }

    if (action === 'edit') {
      if (!a.editable()) {
        return fail(
          'unrepresentable',
          `Stacki cannot model ${a.openFile()} as a tree, so there is nothing here to edit semantically. ` +
            'Use the source domain, which reports the same file as text.'
        );
      }
      if (!writable) {
        return fail(
          'not_editable',
          'Stacki found this element by position alone, on a tree that is not the one the ref was made for. ' +
            'That is good enough to look at and not good enough to write through. Read the target again ' +
            'on this checkout, or select it in Stacki.'
        );
      }
      const doc = documentOf(a);
      if (args.expectedRevision != null && args.expectedRevision !== doc.revision) {
        return fail(
          'stale_target',
          `${doc.file} has changed since you read it (revision ${args.expectedRevision} → ${doc.revision}). Nothing was changed.`,
          { document: doc }
        );
      }
      if (args.expectedDigest != null && args.expectedDigest !== doc.digest) {
        return fail('stale_target', `${doc.file} has changed since you read it. Nothing was changed.`, { document: doc });
      }
      // Every operation names the node it was given unless it says otherwise,
      // so a caller does not repeat the ref once per operation. A move's
      // destination arrives as the keys of a ref the main process read, and is
      // resolved here in the tree those ids belong to.
      const operations = [];
      for (const op of args.operations || []) {
        if (op?.type === 'move') {
          const keys = op.to?.parentKeys || null;
          let parentId = null;
          if (keys && keys.length) {
            const leaf = leafOf({ keys });
            if (!leaf || leaf.file !== a.openFile()) {
              return fail('bad_request', 'A node can only be moved somewhere in the file it already lives in.');
            }
            const found = resolveNode(model?.nodes || [], leaf.indexPath, null, { labelOf: a.crumbLabel });
            if (!found.id) return fail('no_node', 'That move destination is not in the open file any more.');
            parentId = found.id;
          }
          operations.push({ nodeId: id, type: 'move', target: { parentId, index: op.to?.index ?? 0 } });
          continue;
        }
        operations.push({ nodeId: id, ...op });
      }
      const dry = applyOperations(model, operations, { insertables: a.insertables() });
      if (!dry.ok) return { ...dry, ok: false, document: doc };

      const applied = await a.commit(operations, { label: args.label || 'agent edit' });
      if (!applied.ok) return { ...applied, document: doc };
      // What the document was before this edit, whether or not the caller
      // claimed to know. An agent that did not pass expectedRevision still
      // wants both numbers back — that is what makes the next write able to
      // name one.
      // The ref handed back describes ONE node, and it is the node the editor is
      // now on: for an insert that is what was inserted, for a duplicate the
      // copy, for a text or prop edit the node itself. Both halves have to be
      // about that same node — an earlier version took the keys from the new
      // node and the marks from the old one, and the two together described
      // something that was not there, so the very next call could not find it.
      const landed = applied.selectedId || id;
      const after = findNodeById(a.model()?.nodes || [], landed);
      return {
        ok: true,
        notes: dry.notes,
        selected: applied.selectedId || null,
        documentBefore: doc,
        document: documentOf(a),
        keys: a.keysFor(landed),
        fingerprint: after
          ? {
              nodeKind: after.kind || null,
              tag: after.name || null,
              text: textOf(after).join(' ').trim() || null,
              breadcrumbs: a.crumbsFor(landed),
              peers: a.peersFor(landed),
            }
          : null,
        // The node the ref should now name. Identity survives most edits and
        // does not survive all of them — a delete leaves nothing to point at.
        gone: !findNodeById(a.model()?.nodes || [], id),
      };
    }

    return fail('bad_action', `target has no action "${action}".`);
  }

  async function style(action, args) {
    const a = app();
    if (!a.project()) return fail('no_project', 'No project is open in Stacki.');
    if (action === 'list_sources') return { ok: true, ...(await styleAgent.listSources()) };

    let id = a.selectedId();
    if (args.anchor) {
      const at = await locate(a, args.anchor, { navigate: true });
      if (!at.ok) return at;
      id = at.id;
      // Styles are read against the live page, so the element has to BE the
      // selected one — that is what the canvas answers about.
      a.select(id, args.occurrence);
      await a.settle();
    }
    if (!id) return fail('no_selection', 'Nothing is selected in Stacki, and no ref was given.');
    const node = findNodeById(a.model()?.nodes || [], id);
    if (!node) return fail('no_node', 'That element is not in the open file any more.');

    try {
      if (action === 'read') {
        const styles = await styleAgent.readStyles(node, { pathOf: a.pathFor, properties: args.properties || null });
        return { ok: true, ...styles, document: documentOf(a) };
      }
      if (action === 'set_property') {
        const result = await styleAgent.setProperty(node, args);
        return result.ok ? { ...result, document: documentOf(a) } : result;
      }
      if (action === 'remove_property') {
        const result = await styleAgent.removeProperty(node, args);
        return result.ok ? { ...result, document: documentOf(a) } : result;
      }
      if (action === 'set_declarations') {
        const result = await styleAgent.setDeclarations(node, args);
        return result.ok ? { ...result, document: documentOf(a) } : result;
      }
    } catch (err) {
      return fail('style_failed', String(err?.message || err));
    }
    return fail('bad_action', `style has no action "${action}".`);
  }

  async function project(action, args = {}) {
    const a = app();
    if (action === 'undo') {
      const before = a.historyDepth();
      await a.undo();
      return { ok: true, undone: a.historyDepth().past < before.past, history: a.historyDepth(), document: documentOf(a) };
    }
    if (action === 'redo') {
      const before = a.historyDepth();
      await a.redo();
      return { ok: true, redone: a.historyDepth().future < before.future, history: a.historyDepth(), document: documentOf(a) };
    }
    if (action === 'dev_status') {
      return { ok: true, ...a.preview() };
    }
    // Through the app's own preview, so what dev_status reads next is what this
    // just did. Main still does the work; the difference is that the app is
    // told about it rather than finding out from a process exit.
    if (action === 'dev_start') {
      try {
        const started = await a.startPreview();
        // startPreview reports its own failures to the person and returns; a
        // preview with no address did not start, and saying ok:true here would
        // send an agent off to look at a page that is not being served.
        if (!started?.url) {
          return fail('failed', 'The dev server did not start. Stacki has the log in the preview area.');
        }
        return { ok: true, ...started };
      } catch (err) {
        return fail('failed', String(err?.message || err));
      }
    }
    if (action === 'dev_stop') {
      // What stopping just made true, not what React has re-rendered since.
      const stopped = await a.stopPreview();
      return { ok: true, ...stopped };
    }
    // Not an action any tool can name — there is nothing for it in the registry
    // or the schemas. The main process sends it after a write that changed the
    // file the editor has open, so the model, the disk and the canvas agree
    // again before anybody reads the next revision.
    // Also not an action any tool can name. The main process sends it after a
    // write it carried out itself, so that write lands on the same undo stack
    // the panel's version of it lands on.
    // Replacing the open document's source, through the editor rather than
    // round it. Not an action any tool can name: the main process sends it when
    // a raw write turns out to be about the file Stacki has open. See
    // App.jsx's writeOpenSource.
    if (action === 'write_open_source') {
      const done = await a.writeOpenSource(args.text);
      return { ...done, document: documentOf(a) };
    }
    if (action === 'record_undo') {
      const done = await a.recordUndo(args);
      return { ok: true, undoable: !!done };
    }
    if (action === 'reload_open_document') {
      const done = await a.reloadOpenPage();
      return { ...done, document: documentOf(a) };
    }
    return fail('bad_action', `project has no renderer action "${action}".`);
  }

  // The page operations that need the LIVE model rather than a file.
  //
  // component_create is the whole reason this domain reaches the renderer.
  // Making a component out of something means four things — the file, the
  // import, the props derived from real page scope, and the markup replaced by
  // the instance — and only this side knows the model those come from. The
  // main-process `component:create` stays what it always was: the primitive
  // that writes the file.
  async function page(action, args) {
    const a = app();
    if (!a.project()) return fail('no_project', 'No project is open in Stacki.');

    if (action === 'component_create') {
      const anchor = args.anchor || null;
      if (!anchor) return fail('bad_ref', 'component_create needs a ref to the node to turn into a component.');

      const at = await locate(a, anchor, { navigate: true });
      if (!at.ok) return at;
      const writable = at.writable === undefined ? a.writableFor(anchor, at.confidence) : at.writable;
      if (!writable) {
        return fail('not_editable', 'That node is not editable here, so it cannot be turned into a component.');
      }

      // The document has to be the one the ref saw. Checked before anything is
      // written, so a stale ref cannot leave a component file behind.
      const doc = documentOf(a);
      if (args.expectedRevision != null && args.expectedRevision !== doc.revision) {
        return fail(
          'stale_target',
          `${doc.file} has changed since you read it (revision ${args.expectedRevision} → ${doc.revision}). Nothing was changed.`,
          { document: doc }
        );
      }
      if (args.expectedDigest != null && args.expectedDigest !== doc.digest) {
        return fail('stale_target', `${doc.file} has changed since you read it. Nothing was changed.`, { document: doc });
      }

      const node = findNodeById(a.model()?.nodes || [], at.id);
      if (!node) return fail('no_node', 'That element is no longer in the page.');

      const done = await a.extractComponent(node, args.name, { withProps: args.withProps !== false });
      if (!done?.ok) return fail(done?.code || 'failed', done?.message || 'The component could not be made.');

      return {
        ok: true,
        name: done.name,
        path: done.path,
        props: done.props,
        replaced: done.replaced,
        // Reads page scope with no props to carry it: the markup moved but the
        // values it needs did not. Worth saying, rather than leaving the agent
        // to discover a broken component later.
        stranded: done.stranded,
        // The extraction committed; something after it did not. Said out loud
        // rather than folded into ok:false, because an agent told a mutation
        // failed will reasonably make it again — and this one already happened.
        ...(done.notes?.length ? { notes: done.notes } : {}),
        document: documentOf(a),
      };
    }
    return fail('bad_action', `page has no renderer action "${action}".`);
  }

  return async function run(params) {
    const { domain, action, ...args } = params || {};
    try {
      if (domain === 'target') return await target(action, args);
      if (domain === 'style') return await style(action, args);
      if (domain === 'project') return await project(action, args);
      if (domain === 'page') return await page(action, args);
      return fail('bad_domain', `Stacki's window answers for target, style, project and page — not \"${domain}\".`);
    } catch (err) {
      // A command that throws must not look like a command that timed out.
      return fail('command_failed', String(err?.message || err));
    }
  };
}

export default createAgentCommands;
