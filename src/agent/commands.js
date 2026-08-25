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

/** The document's identity right now — what a write names to prove it is current. */
function documentOf(app) {
  return { file: app.openFile(), revision: app.revision(), digest: app.digest() };
}

/**
 * The whole command surface. One object, one switch, no dynamic lookup into
 * anything the app happens to expose.
 */
export function createAgentCommands(getApp) {
  const app = () => getApp();

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

    const model = a.model();
    const node = findNodeById(model?.nodes || [], id);
    if (!node) return fail('no_node', 'That element is not in the open file any more.');

    if (action === 'read') {
      const payload = readTarget({
        node,
        model,
        page: a.page(),
        keys: a.keysFor(id),
        editable: a.editable(),
        crumbLabel: a.crumbLabel,
        canvas: id === a.selectedId() ? a.canvas() : null,
        renderedClasses: id === a.selectedId() ? a.renderedClasses() : null,
        componentChain: a.componentChain(),
        breadcrumbs: a.breadcrumbs(id),
        hidden: a.isHidden(id),
        inert: a.isInert(id),
        confidence,
        writable,
      });
      return { ok: true, target: payload, document: documentOf(a), navigated, note, peers: a.peersFor(id) };
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
      // so a caller does not repeat the ref once per operation.
      const operations = (args.operations || []).map((op) => ({ nodeId: id, ...op }));
      const dry = applyOperations(model, operations, { insertables: a.insertables() });
      if (!dry.ok) return { ...dry, ok: false, document: doc };

      const applied = await a.commit(operations, { label: args.label || 'agent edit' });
      if (!applied.ok) return { ...applied, document: doc };
      return {
        ok: true,
        notes: dry.notes,
        selected: applied.selectedId || null,
        document: documentOf(a),
        keys: a.keysFor(applied.selectedId || id),
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

  async function project(action) {
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
    return fail('bad_action', `project has no renderer action "${action}".`);
  }

  return async function run(params) {
    const { domain, action, ...args } = params || {};
    try {
      if (domain === 'target') return await target(action, args);
      if (domain === 'style') return await style(action, args);
      if (domain === 'project') return await project(action, args);
      return fail('bad_domain', `Stacki's window answers for target, style and project — not "${domain}".`);
    } catch (err) {
      // A command that throws must not look like a command that timed out.
      return fail('command_failed', String(err?.message || err));
    }
  };
}

export default createAgentCommands;
