// What Stacki is showing, as one serializable object.
//
// The renderer holds forty pieces of React state; an agent needs one answer.
// This is the boundary between the two: the renderer publishes a payload built
// from what it has, and this turns it into the snapshot the MCP tools read —
// clamped, rounded, project-relative, and with the selection resolved to lines
// in files by the same resolver ⇧⌘C uses.
//
// Two things it deliberately does NOT do:
//
//   - throw for an empty app. No project, no page, nothing selected and a
//     preview still starting are all normal, and each gets a `status` of its
//     own. An agent asking "what is selected" before anything is wants to be
//     told that, not handed an error.
//   - keep a second copy of anything. The store holds the last published
//     snapshot and nothing else; whatever it can't answer from that (computed
//     styles, a screenshot) is asked for live.
//
// `revision` counts CHANGES, not publishes. The renderer republishes on every
// render that touches the selection, and most of those say exactly what the
// last one said; a number that went up regardless would tell an agent the page
// had re-rendered when it hadn't.

const path = require('path');

const toPosix = (p) => String(p).split(path.sep).join('/');

// Enough of each to identify what is selected, capped so one enormous class
// attribute or a paragraph of copy can't dominate the response.
const MAX_TEXT = 400;
const MAX_PROP_VALUE = 200;
const MAX_PROPS = 40;
const MAX_CLASSES = 60;
const MAX_CHAIN = 30;
const MAX_TRAIL = 20;

const STATUSES = ['ready', 'no_project', 'no_page', 'no_selection', 'preview_not_ready'];

const str = (v, max = 200) => {
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) + '…' : text;
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

const rectOf = (r) => {
  if (!r || typeof r !== 'object') return null;
  const box = { x: num(r.x), y: num(r.y), width: num(r.w ?? r.width), height: num(r.h ?? r.height) };
  return Object.values(box).every((v) => v === null) ? null : box;
};

const sidesOf = (s) => {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const v = num(s[side]);
    if (v !== null) out[side] = v;
  }
  return Object.keys(out).length ? out : null;
};

const spacingOf = (s) => {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  const padding = sidesOf(s.padding);
  const margin = sidesOf(s.margin);
  if (padding) out.padding = padding;
  if (margin) out.margin = margin;
  // The gap bands are rectangles on the page; their COUNT and size is the
  // useful part, not where each one sits.
  if (Array.isArray(s.gaps) && s.gaps.length) {
    out.gaps = s.gaps
      .slice(0, 12)
      .map((g) => ({ axis: g?.axis === 'row' ? 'row' : 'column', size: num(g?.axis === 'row' ? g.h : g.w) }))
      .filter((g) => g.size !== null);
    if (!out.gaps.length) delete out.gaps;
  }
  return Object.keys(out).length ? out : null;
};

const listOf = (v, max, cap = 120) => {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => str(x, cap)).filter(Boolean).slice(0, max);
  return out.length ? out : null;
};

const propsOf = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const key of Object.keys(v).slice(0, MAX_PROPS)) {
    const raw = v[key];
    if (raw === true) out[key] = 'true';
    else if (raw === false || raw === null || raw === undefined) continue;
    else if (typeof raw === 'number') out[key] = String(raw);
    else {
      const text = str(String(raw), MAX_PROP_VALUE);
      if (text) out[key] = text;
    }
  }
  return Object.keys(out).length ? out : null;
};

/** A project path made relative to the project root, posix-spelled. */
function relativeTo(root, file) {
  if (!file) return null;
  if (!root) return toPosix(file);
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? toPosix(rel) : toPosix(file);
}

/**
 * Turn a renderer payload into the published snapshot.
 *
 * `resolveTrail(keys)` answers with `[{ file, startLine, endLine }]` for the
 * selection's node keys, or null — injected so this file needs neither a
 * project on disk nor the Astro parser to be tested.
 */
function normalize(payload, resolveTrail) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const root = str(p.project?.root, 512);
  const pageFile = p.page?.file ? relativeTo(root, p.page.file) : null;
  const pageRoute = str(p.page?.route, 200);

  const snapshot = {
    project: { root },
    page: { route: pageRoute, file: pageFile },
    view: {
      device: str(p.view?.device, 32),
      viewportWidth: int(p.view?.viewportWidth),
      viewportHeight: int(p.view?.viewportHeight),
    },
    selection: emptySelection(),
  };

  if (!root) {
    snapshot.selection.status = 'no_project';
    return snapshot;
  }
  if (!pageFile && !pageRoute) {
    snapshot.selection.status = 'no_page';
    return snapshot;
  }

  const sel = p.selection && typeof p.selection === 'object' ? p.selection : null;
  if (!sel || !sel.present) {
    snapshot.selection.status = 'no_selection';
    // Which file is open still says where the user is, even with nothing picked.
    snapshot.selection.componentChain = listOf(p.selection?.componentChain, MAX_CHAIN);
    return snapshot;
  }

  const trail = (typeof resolveTrail === 'function' ? resolveTrail(sel.keys) : null) || [];
  const sourceTrail = trail.slice(0, MAX_TRAIL).map((e) => ({
    file: str(e?.file, 512),
    startLine: int(e?.startLine),
    endLine: int(e?.endLine),
  }));
  const leaf = sourceTrail[sourceTrail.length - 1] || null;

  const rect = rectOf(sel.rect);
  // On the page but not measurable: the dev server is still coming up, the
  // frame has not reported its boxes yet, or the node rendered nothing. Either
  // way the geometry half of the answer is missing and saying so is the point.
  const measured = !!rect && p.preview?.status === 'on';

  snapshot.selection = {
    status: measured ? 'ready' : 'preview_not_ready',
    nodeKind: str(sel.nodeKind, 32),
    tag: str(sel.tag, 64),
    occurrence: int(sel.occurrence),
    occurrenceCount: int(sel.occurrenceCount),
    source: leaf,
    sourceTrail: sourceTrail.length ? sourceTrail : null,
    componentChain: listOf(sel.componentChain, MAX_CHAIN),
    breadcrumbs: listOf(sel.breadcrumbs, MAX_CHAIN),
    text: str(sel.text, MAX_TEXT),
    props: propsOf(sel.props),
    classes: listOf(sel.classes, MAX_CLASSES, 80),
    hidden: sel.hidden === true,
    inert: sel.inert === true,
    rect,
    spacing: spacingOf(sel.spacing),
  };
  return snapshot;
}

function emptySelection() {
  return {
    status: 'no_selection',
    nodeKind: null,
    tag: null,
    occurrence: null,
    occurrenceCount: null,
    source: null,
    sourceTrail: null,
    componentChain: null,
    breadcrumbs: null,
    text: null,
    props: null,
    classes: null,
    hidden: false,
    inert: false,
    rect: null,
    spacing: null,
  };
}

/** The snapshot nobody has published to yet — a project that isn't open. */
function emptySnapshot() {
  return {
    project: { root: null },
    page: { route: null, file: null },
    view: { device: null, viewportWidth: null, viewportHeight: null },
    selection: { ...emptySelection(), status: 'no_project' },
  };
}

function createContextStore({ resolveTrail, now = Date.now } = {}) {
  let revision = 0;
  let snapshot = emptySnapshot();
  let timestamp = now();
  let key = JSON.stringify(snapshot);

  return {
    /** Take a renderer payload. Answers the revision it settled on. */
    publish(payload) {
      const next = normalize(payload, resolveTrail);
      const nextKey = JSON.stringify(next);
      if (nextKey === key) return revision;
      snapshot = next;
      key = nextKey;
      timestamp = now();
      revision += 1;
      return revision;
    },
    /** Nothing is open any more — back to where a cold start begins. */
    reset() {
      const next = emptySnapshot();
      const nextKey = JSON.stringify(next);
      if (nextKey === key) return revision;
      snapshot = next;
      key = nextKey;
      timestamp = now();
      revision += 1;
      return revision;
    },
    /** The current snapshot, stamped. Freshly built, so callers can't mutate it. */
    read() {
      return { revision, timestamp, ...JSON.parse(key) };
    },
    get revision() {
      return revision;
    },
  };
}

module.exports = { createContextStore, normalize, emptySnapshot, STATUSES, relativeTo };
