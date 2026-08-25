// Where the reviews are owned.
//
// The store is a file and a list; this is the part that knows there is an app
// around it — which project is open, which window to tell when something
// changes, and how to ask the canvas to go and look at something.
//
// It is one module with one live store because there is one window with one
// project open in it. Two callers reach it: the renderer, over a small IPC
// surface that can only name a review by id (it never gets to name a file, so
// no path from the renderer can read or write anywhere in userData), and the
// MCP tools, over the same methods. Both go through the store's single `apply`,
// so the panel and an agent cannot drift into meaning different things by
// "resolve".
//
// `focus` is the one operation that is not about stored state at all: it asks
// the live app to navigate somewhere. That goes over the renderer round-trip
// the MCP server already has, because the alternative — main-process code
// reaching into React state — is the thing the existing architecture is
// carefully not doing.

const { ipcMain } = require('electron');

const {
  createReviewStore,
  selectThreads,
  project,
  fileFor,
  MAX_RESPONSE_BYTES,
} = require('./store');
const { anchorFrom } = require('./anchor');

// Focusing a review can mean loading a page, drilling into two components and
// waiting for the canvas to scroll. The context questions get 4 seconds; this
// legitimately needs more, and an agent waiting is better than an agent told
// "could not focus" about something that was about to work.
const FOCUS_TIMEOUT_MS = 12000;

let store = null;
let userData = null;
let projectPath = null;
let sendToWindow = null;
let registered = false;

// Handed over by the MCP wiring, which already owns both.
let ask = null;
let readPayload = () => null;
let resolveTrail = () => null;

const noProject = () => ({ ok: false, code: 'no_project', message: 'No project is open in Stacki.' });

function announce(revision) {
  try {
    sendToWindow?.('reviews:changed', { revision });
  } catch {
    /* the window went away; the next open reads from disk anyway */
  }
}

/** The project's ledger, opened (or started) for the project now on screen. */
function openProject(next) {
  const resolved = next || null;
  if (!resolved || !userData) return null;
  if (store && projectPath === resolved) return store;
  // The previous project's last write must land before its store is dropped.
  store?.flushSync();
  projectPath = resolved;
  store = createReviewStore({
    file: fileFor(userData, resolved),
    projectPath: resolved,
    onChange: announce,
  });
  announce(store.revision);
  return store;
}

/** Nothing is open. The ledger is closed, not emptied. */
function closeProject() {
  store?.flushSync();
  store = null;
  projectPath = null;
  announce(0);
}

/**
 * Everything read-only, in the shape both the panel and `get_comments` want.
 *
 * `page` and `keys` come from the caller because "the current page" means the
 * page the CANVAS is on, which is the published payload's business, not this
 * module's.
 */
function list({
  status = 'open',
  scope = 'project',
  detail: level = 'summary',
  limit = 50,
  page = null,
  keys = null,
  // Whether a full read also resolves each anchor to its CURRENT file:line.
  // An agent wants that — it is about to go and edit those lines. The panel
  // does not: it has the live model in front of it, and paying a parse per
  // file every time somebody switches a filter is exactly the sort of
  // background work this feature is supposed not to add.
  withSource = true,
} = {}) {
  // An empty app is a status, not an error — and it still has to answer in the
  // shape the schema promises. A response missing half its fields is rejected
  // by the client's own validation, which turns "no project is open" into an
  // unreadable protocol failure.
  if (!store) {
    return { ...noProject(), status, scope, reviews: [], total: 0, returned: 0, truncated: false, revision: 0, problem: null };
  }
  const picked = selectThreads(store.all(), { status, scope, page, keys, limit });
  return {
    ok: true,
    revision: store.revision,
    status,
    scope,
    // What went wrong reading the ledger, so a panel that is empty because a
    // file could not be read does not look like a project nobody has
    // commented on.
    problem: store.problem || null,
    ...project(picked, { detail: level, resolver: withSource === false ? null : resolveTrail }),
  };
}

/**
 * Create, reply, resolve, defer, reopen.
 *
 * `create` targets whatever Stacki has selected right now — the same selection
 * `get_context` describes, taken from the same published payload. There is no
 * way to create a review against something that is not on screen, which is the
 * point: a review whose anchor was assembled from arguments is a review nobody
 * was looking at.
 */
function act(input = {}) {
  if (!store) return noProject();
  if (input.action !== 'create') {
    const result = store.apply(input);
    return result.ok ? { ...result, review: detail(result.thread, resolveTrail), revision: store.revision } : result;
  }

  // What the comment is about. An agent's `create` means the live selection,
  // so it takes the payload the renderer last published. A click in comment
  // mode means the element under the pointer, which is not necessarily what is
  // selected — the app builds a payload aimed at THAT node with its own
  // builder and sends it here, so both go through one anchor builder and one
  // set of keys.
  const built = anchorFrom(input.payload || readPayload(), { pin: input.pin });
  if (!built.ok) {
    const why = {
      no_project: 'No project is open in Stacki.',
      no_page: 'Stacki is not showing a page.',
      no_selection: 'Nothing is selected in Stacki. Select the element to comment on first.',
    };
    return { ok: false, code: built.reason, message: why[built.reason] || 'There is nothing to comment on.' };
  }
  // The lines as they are at the moment of writing, frozen into the creation
  // snapshot. The anchor itself keeps no lines — those are resolved live — but
  // this copy is what makes an orphaned review still readable.
  built.creationContext.sourceTrail = resolveTrail(built.anchor.keys) || null;

  const result = store.apply({
    action: 'create',
    message: input.message,
    authorType: input.authorType,
    anchor: built.anchor,
    creationContext: built.creationContext,
  });
  return result.ok ? { ...result, review: detail(result.thread, resolveTrail), revision: store.revision } : result;
}

/** A person colouring their own notes. Never reachable from MCP — see the store. */
function recolor(threadId, color) {
  if (!store) return noProject();
  const result = store.setColor(threadId, color);
  return result.ok ? { ok: true, review: detail(result.thread, null), revision: store.revision } : result;
}

/**
 * A person rewording what they wrote. Never reachable from MCP — see the store.
 *
 * Only their own messages, and only from the panel: an agent that could
 * rewrite the conversation is an agent whose record of it means nothing.
 */
function editMessage({ threadId, messageId, message } = {}) {
  if (!store) return noProject();
  const result = store.editMessage(threadId, messageId, message);
  return result.ok ? { ok: true, review: detail(result.thread, null), revision: store.revision } : result;
}

/** A person pruning their own thread. Never reachable from MCP — see the store. */
function removeMessage({ threadId, messageId } = {}) {
  if (!store) return noProject();
  const result = store.removeMessage(threadId, messageId);
  return result.ok ? { ok: true, review: detail(result.thread, null), revision: store.revision } : result;
}

/** A human deleting their own note. Never reachable from MCP — see the store. */
function remove(threadId) {
  if (!store) return noProject();
  const result = store.remove(threadId);
  return result.ok ? { ok: true, id: threadId, revision: store.revision } : result;
}

/** The renderer, reporting which anchors it could still find. */
function syncAnchors(list_) {
  if (!store) return noProject();
  return { ...store.syncAnchors(list_), revision: store.revision };
}

/**
 * Send the app to a review's target.
 *
 * Answers with whatever the renderer managed — the page, the breakpoint, the
 * component drill-down, the node, the rendered copy — and says which of those
 * it could not do rather than selecting something else and reporting success.
 * An agent that gets `anchorState: "orphaned"` back should read the review's
 * creation context and decide for itself, not photograph whatever happened to
 * be selected.
 */
async function focus(threadId) {
  if (!store) return noProject();
  const thread = store.get(threadId);
  if (!thread) return { ok: false, code: 'no_thread', message: `No review with id ${threadId || '(none)'}.` };
  if (typeof ask !== 'function') {
    return { ok: false, code: 'no_window', message: 'The Stacki window is not available.' };
  }
  const answer = await ask('review:focus', { threadId, anchor: thread.anchor }, FOCUS_TIMEOUT_MS);
  if (!answer) {
    return {
      ok: false,
      code: 'no_answer',
      message: 'Stacki did not answer in time — the preview may still be starting.',
      review: summarize(thread),
    };
  }
  // The renderer is the only thing that can say whether the anchor resolved,
  // so its answer is what the ledger records — including the positions it
  // actually walked, which may not be the ones it was given.
  //
  // Except when the failure was about this moment rather than about the source:
  // a preview still starting, or the app navigating away mid-walk. Writing
  // those down as `orphaned` would mean that merely looking at a review could
  // mark it lost, which is a read damaging what it read.
  if (answer.anchorState && !answer.transient) {
    syncAnchors([{ id: threadId, anchorState: answer.anchorState, keys: answer.keys }]);
  }
  const after = store.get(threadId) || thread;
  return {
    ok: answer.anchorState === 'attached',
    // A transient failure is not an orphan, and an agent that treated it as one
    // would give up on a review that was about to work.
    code: answer.anchorState === 'attached' ? null : answer.transient ? 'not_ready' : 'orphaned',
    restored: {
      page: !!answer.restored?.page,
      breakpoint: !!answer.restored?.breakpoint,
      component: !!answer.restored?.component,
      node: !!answer.restored?.node,
      occurrence: !!answer.restored?.occurrence,
    },
    note: answer.note || null,
    review: detail(after, resolveTrail),
    revision: store.revision,
  };
}

// --- wiring ------------------------------------------------------------------

/**
 * Register the renderer's door.
 *
 * Deliberately narrow. Nothing here takes a path: the file a review lives in is
 * derived from the project the main process has open, so a renderer cannot ask
 * this to read or write anywhere else in userData.
 */
function start({ userDataPath, send }) {
  userData = userDataPath;
  sendToWindow = send || null;
  if (registered) return;
  registered = true;

  ipcMain.handle('reviews:list', (_e, args) => list({ ...(args || {}), withSource: false }));
  ipcMain.handle('reviews:act', (_e, args) => act(args || {}));
  ipcMain.handle('reviews:remove', (_e, threadId) => remove(threadId));
  ipcMain.handle('reviews:recolor', (_e, args) => recolor(args?.threadId, args?.color));
  ipcMain.handle('reviews:editMessage', (_e, args) => editMessage(args || {}));
  ipcMain.handle('reviews:removeMessage', (_e, args) => removeMessage(args || {}));
  ipcMain.handle('reviews:syncAnchors', (_e, args) => syncAnchors(args));
}

/** The MCP wiring, handing over the two things only it has. */
function attach(parts = {}) {
  if (typeof parts.ask === 'function') ask = parts.ask;
  if (typeof parts.readPayload === 'function') readPayload = parts.readPayload;
  if (typeof parts.resolveTrail === 'function') resolveTrail = parts.resolveTrail;
}

/** Everything scheduled, on disk, before the process goes. */
function flushSync() {
  store?.flushSync();
}

module.exports = {
  start,
  attach,
  openProject,
  closeProject,
  list,
  act,
  remove,
  recolor,
  editMessage,
  removeMessage,
  syncAnchors,
  focus,
  flushSync,
  FOCUS_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
};
