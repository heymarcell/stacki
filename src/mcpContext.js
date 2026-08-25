// What the app tells the MCP server about itself.
//
// The renderer holds the selection across a dozen pieces of state — the model,
// the edit stack, the breadcrumbs, what the canvas measured, what the page
// reported as hidden — and none of that is anybody else's business. This
// flattens it into the one payload the main process normalizes and publishes.
//
// Two rules keep it honest:
//
//   Nothing is invented here. Every field is something the app already knows
//   and already shows somewhere; the node keys are the same ones ⇧⌘C resolves,
//   so an agent's "where is this" and the user's own copy-selection can never
//   disagree.
//
//   It is a pure function of its arguments. No React, no window, no imports of
//   the app — so what gets published can be checked against a table of inputs
//   rather than by driving the editor.

// The visible words inside a node, as the page reads them. Deep enough to name
// a section by its heading, shallow enough not to serialize a whole page.
//
// Exported because Visual Review's anchor resolver compares a node's words
// against the ones a review recorded, and two ways of reading the same node
// would disagree exactly where it matters.
export function textOf(node, depth = 0, out = []) {
  if (!node || depth > 4 || out.join(' ').length > 400) return out;
  if (node.kind === 'text' && typeof node.value === 'string') {
    const text = node.value.trim();
    if (text) out.push(text);
    return out;
  }
  // An expression is not text, but `{post.title}` says more about which
  // element this is than the tag does.
  if (node.kind === 'expr' && typeof node.value === 'string') {
    const text = node.value.trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, depth + 1, out);
  }
  return out;
}

/** The tag a node renders as, or null for anything that isn't an element. */
export function tagOf(node) {
  if (!node) return null;
  if (node.kind === 'element' || node.kind === 'raw') return node.name || null;
  if (node.kind === 'component') return node.name || null;
  return null;
}

/**
 * Build the payload for `window.avb.mcpPublish`.
 *
 * `canvas` is what PreviewPane last reported — the breakpoint the canvas is
 * actually in, the frame's size, and the selected occurrence's box. Absent
 * (no preview, a page that has not rendered) it simply leaves the geometry
 * out, and the published status says `preview_not_ready`.
 */
export function buildMcpPayload({
  project,
  branch,
  peers,
  currentPage,
  pageRoute,
  editStack,
  selectedId,
  selectedNode,
  selectionKeys,
  crumbs,
  selectedClasses,
  hidden,
  inert,
  devStatus,
  canvas,
}) {
  const payload = {
    // The branch rides along so a review can record which one it was written
    // against. The MCP snapshot's normalizer builds its answer from named
    // fields, so nothing here changes what get_context returns.
    project: { root: project?.path || null, branch: branch || null },
    page: {
      route: pageRoute || null,
      // The page on the canvas, not the file being edited — drilling into a
      // component does not change which page is on screen.
      file: (editStack && editStack[0]?.path) || currentPage?.path || null,
    },
    view: {
      device: canvas?.device || null,
      viewportWidth: canvas?.viewportWidth ?? null,
      viewportHeight: canvas?.viewportHeight ?? null,
    },
    preview: { status: devStatus || 'off' },
    selection: { present: false },
  };

  if (!selectedId || !selectedNode) {
    payload.selection = {
      present: false,
      componentChain: (editStack || []).map((e) => e?.name).filter(Boolean),
    };
    return payload;
  }

  payload.selection = {
    present: true,
    nodeKind: selectedNode.kind || null,
    tag: tagOf(selectedNode),
    occurrence: canvas?.occurrence ?? null,
    occurrenceCount: canvas?.occurrenceCount ?? null,
    // Which copy of the OUTERMOST component instance is being edited, when one
    // is. A component inside a loop is on the page once per item; drilling into
    // the third card narrows everything the canvas reports to that card, and a
    // review that came back to the first one would be looking at the wrong
    // instance of the right node.
    instanceOccurrence: (editStack || []).length > 1 ? editStack[1]?.focusOcc ?? 0 : null,
    // The sibling run at every level on the way down to this node. It is what
    // lets a review tell "nothing moved" apart from "something was inserted
    // above me" — without it an index path is not identity among same-kind
    // siblings. See src/reviewAnchor.js.
    peers: Array.isArray(peers) ? peers : null,
    keys: selectionKeys || [],
    // The route an editor takes to reach this: the page, then each component
    // opened on the way down.
    componentChain: (editStack || []).map((e) => e?.name).filter(Boolean),
    breadcrumbs: (crumbs || []).map((c) => c?.label).filter(Boolean),
    text: textOf(selectedNode).join(' ').trim() || null,
    props: selectedNode.props || null,
    // What the element actually carries on the page. A class written as an
    // expression has no text in the source, so this is the only place the
    // applied classes are knowable.
    classes: selectedClasses && selectedClasses.length ? selectedClasses : null,
    hidden: !!hidden,
    inert: !!inert,
    rect: canvas?.rect || null,
    spacing: canvas?.spacing || null,
  };
  return payload;
}

export default buildMcpPayload;
