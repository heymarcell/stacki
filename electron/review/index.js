// Where the reviews are owned.
//
// The store is a file and a list; this is the part that knows there is an app
// around it — which project is open, which window to tell when something
// changes, how to ask the canvas to go and look at something, and (since
// Shared Reviews) which workspace this project belongs to and when to catch up
// with it.
//
// It is one module with one live store because there is one window with one
// project open in it. Three callers reach it: the renderer, over a small IPC
// surface that can only name a review by id (it never gets to name a file, so
// no path from the renderer can read or write anywhere in userData), the MCP
// tools, over the same methods, and the syncer. All of them go through the
// store's single `apply`, so the panel, an agent and another person's machine
// cannot drift into meaning different things by "resolve".
//
// `focus` is the one operation that is not about stored state at all: it asks
// the live app to navigate somewhere. That goes over the renderer round-trip
// the MCP server already has, because the alternative — main-process code
// reaching into React state — is the thing the existing architecture is
// carefully not doing.
//
// WHAT AN AGENT CANNOT DO HERE, restated because sharing widens the blast
// radius of getting it wrong: it cannot create a workspace, make an invitation,
// join anything, change a server address, or read a credential. Those are
// human actions in the app's own window. MCP gets the same five review verbs
// it always had.

const path = require('node:path');

const { ipcMain } = require('electron');

const {
  createReviewStore,
  selectThreads,
  project,
  summarize,
  detail,
  fileFor,
  scopeKey,
  MAX_RESPONSE_BYTES,
} = require('./store');
const { anchorFrom } = require('./anchor');
const { createCheckout } = require('./checkout');
const { localActor, setLocalName, suggestName, agentActor, displayName } = require('./actors');
const { createWorkspaces } = require('./workspaces');
const { createSyncer, legacyLink } = require('./sync');
const {
  createWorkspace: createRemoteWorkspace,
  joinWorkspace: joinRemoteWorkspace,
  createTransport,
  packInvite,
  unpackInvite,
} = require('./transport');
const { remoteHint, git } = require('./provenance');
const { createSecureRooms } = require('./secure/secrets');
const {
  createSecureTransport,
  createRoom: createSecureRoom,
  joinRoom: joinSecureRoom,
} = require('./secure/transport');
const { unpackCapability, shareLink } = require('./secure/capability');
const { relayFor, describeRelay, checkRelay, DEFAULT_RELAY } = require('./secure/relays');

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
let checkout = null;
let registry = null;
let syncer = null;
// This installation's own person, and the project's normalized remote. Both
// cost a file read or a `git` call, and `list` runs on every notification and
// every filter change — so they are worked out once per project rather than
// once per read.
let identityCache = null;
let hintCache = null;
// The workspace this project belongs to, credential and all. Never leaves the
// main process: `publicOf` is what the renderer gets.
let workspace = null;
// The secure room this project belongs to, if it has one. A project is either
// legacy-shared or securely shared and never both — there is one `shared`
// slot in the ledger and one row in the panel.
let secureRooms = null;
let room = null;
// Set only while a join confirmation is on screen. Never persisted, never
// written to disk, and cleared the moment the dialog closes — see §61.
let pendingJoin = null;

// Handed over by the MCP wiring, which already owns both.
let ask = null;
let readPayload = () => null;
let resolveTrail = () => null;
// How a focused review turns into something an agent can act on. Supplied by
// the MCP wiring, which owns ref identity; null when nothing has attached, and
// then a focus simply carries no ref — the review is still readable, which is
// the same bargain the pin makes.
let mintRef = () => null;

const noProject = () => ({ ok: false, code: 'no_project', message: 'No project is open in Stacki.' });

function announce(revision) {
  try {
    sendToWindow?.('reviews:changed', { revision });
  } catch {
    /* the window went away; the next open reads from disk anyway */
  }
}

/** This installation's own person, made on first need and then kept. */
function me() {
  if (!userData) return null;
  if (!identityCache) identityCache = localActor(userData, { suggest: () => suggestName({ run: git, projectPath }) });
  return identityCache;
}

/** The project's ledger, opened (or started) for the project now on screen. */
function openProject(next) {
  const resolved = next || null;
  if (!resolved || !userData) return null;
  if (store && projectPath === resolved) return store;
  // The previous project's last write must land before its store is dropped.
  store?.flushSync();
  projectPath = resolved;
  checkout = createCheckout({ projectPath: resolved });
  syncer?.reset();
  // A hint and nothing else — see workspaces.js. Read once here rather than on
  // every list, because it is two `git` calls.
  hintCache = remoteHint(resolved);
  // Secure first: a project that has a room is not consulted about a legacy
  // workspace, so the two can never both be live for one project.
  room = secureRooms ? secureRooms.forProject(scopeKey(resolved)) : null;
  workspace = room ? null : registry ? registry.forProject(scopeKey(resolved)) : null;
  const actor = me();
  store = createReviewStore({
    file: fileFor(userData, resolved),
    projectPath: resolved,
    actor,
    onChange: announce,
  });
  // The ledger and the registry can disagree — a workspace forgotten while the
  // project was closed, say. The registry is the one holding the credential,
  // so it decides, and the ledger is told to stop sharing rather than left
  // queueing events nothing will ever send.
  if (store.shared.workspaceId && !workspace && !room) store.disableShared();
  announce(store.revision);
  // Opening a shared project is one of the three moments this app talks to a
  // server. It is deliberately not awaited: the panel shows what is on disk
  // immediately and grows the rest when it arrives.
  if (workspace || room) void syncNow('open');
  return store;
}

/** Nothing is open. The ledger is closed, not emptied. */
function closeProject() {
  store?.flushSync();
  store = null;
  projectPath = null;
  checkout = null;
  workspace = null;
  room = null;
  pendingJoin = null;
  hintCache = null;
  syncer?.reset();
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
    return {
      ...noProject(),
      status,
      scope,
      reviews: [],
      total: 0,
      returned: 0,
      truncated: false,
      revision: 0,
      problem: null,
      shared: sharedStatus(),
    };
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
    // Whether this project is shared, with whom, and how the last catch-up
    // went. Always present, so a client never has to ask twice.
    shared: sharedStatus(),
    ...project(picked, {
      detail: level,
      resolver: withSource === false ? null : resolveTrail,
      // How each review stands against THIS working copy — a different
      // question from what the review says, and the one that stops a shared
      // "resolved" from being read as "fixed on your screen".
      checkout: level === 'full' && checkout ? (thread) => checkout.forThread(thread) : null,
      // Who "you" are, so each review can say whether it came from this
      // keyboard or arrived from somebody else's. An agent that can now edit
      // the project needs that difference on the object rather than inferred
      // from a name it has no way to check.
      localId: me()?.id || null,
    }),
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
  const withActor = { ...input, actor: input.actor || (input.authorType === 'agent' ? agentActor(agentName()) : me()) };
  if (input.action !== 'create') {
    const result = store.apply(withActor);
    return result.ok ? { ...result, review: reviewOf(result.thread), revision: store.revision } : result;
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
    actor: withActor.actor,
    anchor: built.anchor,
    creationContext: built.creationContext,
  });
  return result.ok ? { ...result, review: reviewOf(result.thread), revision: store.revision } : result;
}

/** One review, in full, with everything this checkout can say about it. */
const reviewOf = (thread) =>
  thread ? detail(thread, resolveTrail, checkout ? (t) => checkout.forThread(t) : null) : null;

/** A person colouring their own notes. Never reachable from MCP — see the store. */
function recolor(threadId, color) {
  if (!store) return noProject();
  const result = store.setColor(threadId, color, me());
  return result.ok ? { ok: true, review: reviewOf(result.thread), revision: store.revision } : result;
}

/**
 * A person rewording what they wrote. Never reachable from MCP — see the store.
 *
 * Only their own messages, and only from the panel: an agent that could
 * rewrite the conversation is an agent whose record of it means nothing, and
 * one person rewriting another's is worse.
 */
function editMessage({ threadId, messageId, message } = {}) {
  if (!store) return noProject();
  const result = store.editMessage(threadId, messageId, message, me());
  return result.ok ? { ok: true, review: reviewOf(result.thread), revision: store.revision } : result;
}

/** A person pruning their own thread. Never reachable from MCP — see the store. */
function removeMessage({ threadId, messageId } = {}) {
  if (!store) return noProject();
  const result = store.removeMessage(threadId, messageId, me());
  return result.ok ? { ok: true, review: reviewOf(result.thread), revision: store.revision } : result;
}

/** A human deleting their own note. Never reachable from MCP — see the store. */
function remove(threadId) {
  if (!store) return noProject();
  const result = store.remove(threadId, me());
  return result.ok ? { ok: true, id: threadId, revision: store.revision } : result;
}

/** The renderer, reporting which anchors it could still find. */
function syncAnchors(list_) {
  if (!store) return noProject();
  return { ...store.syncAnchors(list_), revision: store.revision };
}

// --- sharing -----------------------------------------------------------------

/**
 * Which agent is speaking.
 *
 * The MCP client says who it is at initialize, and in the stateless transport
 * this server uses that happens on a different request from the tool call — so
 * it is read when it is there and fallen back on when it is not. Never
 * invented as a person: an unnamed agent is "AI Agent", not you.
 */
let agentNameHint = null;
const agentName = () =>
  displayName(agentNameHint || process.env.STACKI_AGENT_NAME || null, 'AI Agent');

/** Whatever the MCP layer learned about who is connected. */
function noteAgent(name) {
  const shown = displayName(name, '');
  if (shown) agentNameHint = shown;
}

/**
 * How this project is shared, for the sync loop. Null when it is not.
 *
 * The one place that knows there are two kinds. Everything downstream — the
 * syncer, the retry, the problem codes — deals in this shape and never asks
 * which it got.
 */
function linkFor() {
  if (room) {
    return {
      kind: 'secure',
      id: room.roomId,
      actorId: room.actorId,
      make: () => createSecureTransport({ rooms: secureRooms, roomId: room.roomId }),
    };
  }
  return legacyLink(workspace);
}

/**
 * What the panel shows. Never a credential, never a room id, never a secret.
 *
 * `mode` is what the row switches on: `off` is a project nobody has shared,
 * `secure` is the one people get now, and `legacy` is a plaintext workspace
 * somebody set up before this existed and which goes on working untouched.
 */
function sharedStatus() {
  const ledger = store ? store.shared : null;
  const who = userData ? me() : null;
  const mode = ledger?.workspaceId ? (room ? 'secure' : workspace ? 'legacy' : 'off') : 'off';
  return {
    mode,
    enabled: mode !== 'off',
    // The legacy shape, kept exactly as it was so nothing that reads it breaks.
    workspace: mode === 'legacy' && registry && workspace ? registry.publicOf(workspace) : null,
    // The secure shape. No id, no relay credential, no key material — see the
    // IPC audit in test/secure-share.js, which walks this object.
    secure: mode === 'secure' && secureRooms ? secureRooms.publicOf(room) : null,
    lastSyncAt: ledger?.lastSyncAt ?? null,
    problem: ledger?.problem ?? null,
    // How much has not left this machine yet. The honest measure of "am I
    // caught up", and the thing that makes offline visible rather than silent.
    pending: ledger?.pending ?? 0,
    // Threads deliberately kept off the share when sharing was enabled.
    private: ledger?.excluded ?? 0,
    syncing: !!syncer?.busy,
    identity: who ? { actorId: who.id, displayName: who.displayName } : null,
    // A workspace this repository might already belong to. A suggestion for a
    // person to look at and nothing else — see workspaces.js. Legacy only:
    // Secure Share has no discovery of any kind, and a git remote is a hint
    // and never a key.
    suggestion: mode === 'off' && registry && projectPath ? registry.suggestFor(hintCache) : null,
    // Where a NEW secure share would be created. Public information.
    relay: describeRelay(relayFor({ preferred: secureRooms?.preferredRelay?.() })),
  };
}

/** Catch up, whichever kind of share this is. */
async function syncNow(reason = 'manual') {
  if (!store) return noProject();
  const link = linkFor();
  if (!link || !store.shared.workspaceId) {
    return { ok: true, skipped: 'not_shared', shared: sharedStatus() };
  }
  const result = await syncer.sync({ store, link, reason });
  announce(store.revision);
  return { ...result, shared: sharedStatus() };
}

// --- secure share -----------------------------------------------------------

/**
 * Start sharing this project's comments securely.
 *
 * Everything secret is made on this machine before a request goes anywhere:
 * the room id, the room secret, this member's room-scoped sender id and its
 * room-specific signing key. The relay is told three values and none of those.
 *
 * `publishExisting` is the privacy decision and it is asked, not assumed —
 * exactly as the legacy path asks it. Off means every comment written before
 * this moment stays on this machine for good.
 */
async function enableSecureShare({ relay = null, publishExisting = false } = {}) {
  if (!store || !projectPath) return noProject();
  const actor = me();
  if (!actor) return { ok: false, code: 'no_identity', message: 'Stacki has no identity to share as.' };
  if (store.shared.workspaceId) {
    return { ok: false, code: 'already_shared', message: 'This project’s comments are already shared.' };
  }
  const origin = relay ? checkRelay(relay) : { ok: true, origin: relayFor({ preferred: secureRooms.preferredRelay() }) };
  if (!origin.ok) return origin;

  const made = await createSecureRoom({ relay: origin.origin, actor, rooms: secureRooms });
  if (!made.ok) return made;
  secureRooms.link(scopeKey(projectPath), made.room.roomId);
  room = made.room;
  workspace = null;
  const turned = store.enableShared({ workspaceId: made.room.roomId, publishExisting });
  if (!turned.ok) return turned;
  const synced = await syncNow('enable');
  return { ok: true, shared: sharedStatus(), published: turned.published, sync: synced };
}

/**
 * Look at an invitation without accepting it.
 *
 * Joining is never automatic and never silent. This is what the confirmation
 * dialog is drawn from, and the capability is held in this process only —
 * the renderer is told what the invitation is FOR, not what it contains.
 */
function inspectInvite(capability) {
  const invitation = unpackCapability(capability);
  if (!invitation) {
    return { ok: false, code: 'bad_capability', message: 'That invitation could not be read.' };
  }
  pendingJoin = invitation;
  return {
    ok: true,
    invite: {
      relay: describeRelay(invitation.relay),
      // The project this would attach to, which is the question a person is
      // actually being asked. Null when nothing is open.
      project: projectPath ? path.basename(projectPath) : null,
      alreadyShared: !!store?.shared?.workspaceId,
    },
  };
}

/** Nothing was accepted. Let go of it. */
function cancelInvite() {
  pendingJoin = null;
  return { ok: true };
}

/**
 * Accept the invitation currently being confirmed.
 *
 * It takes no capability argument on purpose: the only thing that can be
 * joined is the one a person has been shown and has said yes to. A renderer
 * that has been talked into calling this cannot name a different room.
 */
async function joinSecureShare({ publishExisting = false } = {}) {
  if (!store || !projectPath) return noProject();
  if (!pendingJoin) return { ok: false, code: 'no_invite', message: 'There is no invitation to accept.' };
  const actor = me();
  if (!actor) return { ok: false, code: 'no_identity', message: 'Stacki has no identity to join as.' };
  if (store.shared.workspaceId) {
    return { ok: false, code: 'already_shared', message: 'This project’s comments are already shared.' };
  }

  const capability = `stacki2.${Buffer.from(
    JSON.stringify({ r: pendingJoin.relay, id: pendingJoin.roomId, i: pendingJoin.invite, k: pendingJoin.secret }),
    'utf8'
  ).toString('base64url')}`;
  const joined = await joinSecureRoom({ capability, actor, rooms: secureRooms });
  pendingJoin = null;
  if (!joined.ok) return joined;

  secureRooms.link(scopeKey(projectPath), joined.room.roomId);
  room = joined.room;
  workspace = null;
  const turned = store.enableShared({ workspaceId: joined.room.roomId, publishExisting });
  if (!turned.ok) return turned;
  const synced = await syncNow('join');
  return { ok: true, shared: sharedStatus(), published: turned.published, sync: synced };
}

/**
 * A single-use way in for one more person.
 *
 * A human action in the app's own window, never an MCP one. The capability
 * crosses to the renderer because somebody asked for something to copy, and it
 * is not stored anywhere on the way.
 */
async function createSecureInvite({ ttlMs = null } = {}) {
  if (!store || !room) {
    return { ok: false, code: 'not_shared', message: 'This project is not sharing its comments securely.' };
  }
  const transport = createSecureTransport({ rooms: secureRooms, roomId: room.roomId });
  try {
    const made = await transport.createInvite({ ttlMs });
    if (!made.ok) return made;
    return {
      ok: true,
      capability: made.capability,
      // The ordinary form: an https link whose whole payload is after the `#`,
      // so the page it opens is fetched without it.
      link: shareLink({ shareOrigin: made.relay, capability: made.capability }),
      expiresAt: made.expiresAt,
    };
  } finally {
    transport.close();
  }
}

/**
 * Stop this machine talking to the room.
 *
 * Local review history is untouched — every comment stays readable, and what
 * was already shared stays shared. The relay credential is revoked and the
 * room's secrets are forgotten here.
 */
async function leaveSecureShare() {
  if (!store || !room) {
    return { ok: false, code: 'not_shared', message: 'This project is not sharing its comments securely.' };
  }
  const transport = createSecureTransport({ rooms: secureRooms, roomId: room.roomId });
  try {
    // Best effort. A relay that cannot be reached must not be able to keep
    // somebody in a share they have decided to leave.
    await transport.leave();
  } catch {
    /* the local forget below is what actually matters */
  } finally {
    transport.close();
  }
  secureRooms.unlink(scopeKey(projectPath));
  secureRooms.forget(room.roomId);
  room = null;
  const turned = store.disableShared();
  if (!turned.ok) return turned;
  return { ok: true, shared: sharedStatus() };
}

/**
 * End it for everybody.
 *
 * The relay's copy of every envelope goes. What does not go — and what the UI
 * says plainly — is the copy each person already decrypted onto their own
 * machine. Ending a share is not a way to unsay something.
 */
async function endSecureShare() {
  if (!store || !room) {
    return { ok: false, code: 'not_shared', message: 'This project is not sharing its comments securely.' };
  }
  if (!room.isOwner) {
    return { ok: false, code: 'not_owner', message: 'Only the person who started this share can end it.' };
  }
  const transport = createSecureTransport({ rooms: secureRooms, roomId: room.roomId });
  let ended;
  try {
    ended = await transport.end();
  } finally {
    transport.close();
  }
  if (!ended?.ok) return ended || { ok: false, code: 'sync_failed', message: 'Ending this share did not work.' };
  secureRooms.unlink(scopeKey(projectPath));
  secureRooms.forget(room.roomId);
  room = null;
  const turned = store.disableShared();
  if (!turned.ok) return turned;
  return { ok: true, shared: sharedStatus() };
}

/** Which relay new shares go to. A preference, not a credential. */
function setSecureRelay({ relay = null } = {}) {
  if (!secureRooms) return { ok: false, code: 'no_identity', message: 'Stacki has nowhere to keep that.' };
  if (relay == null || relay === '') {
    secureRooms.setPreferredRelay(null);
    return { ok: true, relay: describeRelay(relayFor({})) };
  }
  const checked = checkRelay(relay);
  if (!checked.ok) return checked;
  secureRooms.setPreferredRelay(checked.origin);
  return { ok: true, relay: describeRelay(checked.origin) };
}

/**
 * Start a workspace for this project.
 *
 * `publishExisting` is the privacy question and it is asked, not assumed. See
 * the store's `enableShared`: off means every comment written before this
 * moment stays on this machine forever.
 */
async function enableShared({ server, signupToken, displayName: shown, publishExisting = false } = {}) {
  if (!store || !projectPath) return noProject();
  // Legacy plaintext sharing stays available for the workspaces people already
  // have. It is not a thing to start on top of a secure share.
  if (room) return { ok: false, code: 'already_shared', message: 'This project’s comments are already shared securely.' };
  const actor = me();
  if (!actor) return { ok: false, code: 'no_identity', message: 'Stacki has no identity to share as.' };
  const hint = hintCache;
  const made = await createRemoteWorkspace({
    baseUrl: server,
    signupToken,
    // What everybody will see this called, on every machine and in every
    // agent's read of it. Nobody is asked to name a workspace — the answer is
    // always the project — and defaulting it to the server's own "Shared
    // reviews" made every workspace on every project read identically, which
    // is exactly what the one line at the top of the Comments panel is for.
    displayName: shown || path.basename(projectPath) || null,
    repositoryHint: hint,
    actor,
  });
  if (!made.ok) return made;
  const remembered = registry.remember({
    id: made.workspace.id,
    server: made.server,
    token: made.credential.token,
    displayName: made.workspace.displayName,
    memberId: made.credential.memberId,
    actorId: made.credential.actorId,
    repositoryHint: hint,
  });
  if (!remembered) return { ok: false, code: 'not_stored', message: 'Stacki could not store that workspace.' };
  registry.link(scopeKey(projectPath), remembered.id);
  workspace = remembered;
  const turned = store.enableShared({ workspaceId: remembered.id, publishExisting });
  if (!turned.ok) return turned;
  const synced = await syncNow('enable');
  return { ok: true, shared: sharedStatus(), published: turned.published, sync: synced };
}

/** Accept an invitation to somebody else's workspace, for this project. */
async function joinShared({ invite, publishExisting = false } = {}) {
  if (!store || !projectPath) return noProject();
  if (room) return { ok: false, code: 'already_shared', message: 'This project’s comments are already shared securely.' };
  const actor = me();
  if (!actor) return { ok: false, code: 'no_identity', message: 'Stacki has no identity to join as.' };
  const unpacked = unpackInvite(invite);
  if (!unpacked) return { ok: false, code: 'bad_invite', message: 'That invitation could not be read.' };
  const joined = await joinRemoteWorkspace({ baseUrl: unpacked.server, invite: unpacked.invite, actor });
  if (!joined.ok) return joined;
  const remembered = registry.remember({
    id: joined.workspace.id,
    server: joined.server,
    token: joined.credential.token,
    displayName: joined.workspace.displayName,
    memberId: joined.credential.memberId,
    actorId: joined.credential.actorId,
    repositoryHint: joined.workspace.repositoryHint,
  });
  if (!remembered) return { ok: false, code: 'not_stored', message: 'Stacki could not store that workspace.' };
  registry.link(scopeKey(projectPath), remembered.id);
  workspace = remembered;
  const turned = store.enableShared({ workspaceId: remembered.id, publishExisting });
  if (!turned.ok) return turned;
  const synced = await syncNow('join');
  return { ok: true, shared: sharedStatus(), published: turned.published, sync: synced };
}

/**
 * Stop sharing this project.
 *
 * The local review history is untouched — every comment stays readable, and
 * what was already published stays published. Only the link and this project's
 * outbox go. Anything else would make turning it off a destructive act.
 */
function disableShared() {
  if (!store || !projectPath) return noProject();
  // A secure share is left or ended, never "stopped": one revokes a credential
  // at the relay and the other ends the room for everybody, and quietly
  // dropping the local link instead would leave this machine in a room it has
  // stopped listening to.
  if (room) return { ok: false, code: 'secure_share', message: 'Leave or end the secure share instead.' };
  registry.unlink(scopeKey(projectPath));
  workspace = null;
  const turned = store.disableShared();
  if (!turned.ok) return turned;
  return { ok: true, shared: sharedStatus() };
}

/** A single-use way in for one more person. A human action, never an MCP one. */
async function createInvite({ ttlMs = null } = {}) {
  if (!store || !workspace) {
    return { ok: false, code: 'not_shared', message: 'This project is not sharing its comments.' };
  }
  const transport = createTransport({
    kind: 'http',
    baseUrl: workspace.server,
    token: workspace.token,
    workspaceId: workspace.id,
  });
  try {
    const made = await transport.createInvite({ ttlMs });
    if (!made.ok) return made;
    // One string to paste, carrying the server it belongs to — so joining is
    // never something Stacki works out from a git remote.
    return { ok: true, invite: packInvite({ server: made.server, invite: made.invite }), expiresAt: made.expiresAt };
  } finally {
    transport.close();
  }
}

/** Who this installation is, and what to call them. */
function identity() {
  const actor = me();
  return actor
    ? { ok: true, actorId: actor.id, displayName: actor.displayName, suggested: suggestName({ run: git, projectPath }) }
    : { ok: false, code: 'no_identity', message: 'Stacki has nowhere to keep an identity.' };
}

/**
 * Rename yourself.
 *
 * The id does not move. That is the whole point of having one: a name is
 * presentation, and changing it must not orphan everything already signed with
 * it. Events already written keep the name they were written under, which is
 * the honest record of what a thread said at the time.
 */
function setIdentity({ displayName: shown } = {}) {
  if (!userData) return { ok: false, code: 'no_identity', message: 'Stacki has nowhere to keep an identity.' };
  me();
  const renamed = setLocalName(userData, shown);
  if (!renamed) return { ok: false, code: 'no_identity', message: 'Stacki has no identity to rename.' };
  identityCache = renamed;
  announce(store?.revision || 0);
  return { ok: true, actorId: renamed.id, displayName: renamed.displayName };
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
    syncAnchors([{ id: thread.id, anchorState: answer.anchorState, keys: answer.keys }]);
  }
  const after = store.get(thread.id) || thread;
  // The handle for acting on what was just put on screen — the point of a
  // focus, now that there is something to act with. Issued only when the walk
  // actually landed, and marked read-only on exactly the evidence that
  // withholds a pin: a node recovered on position alone, on a tree the review
  // was not written against, is good enough to look at and not good enough to
  // write through. The renderer decides that (it is the one that resolved the
  // node) and this carries the decision rather than making a second one.
  const targetRef =
    answer.anchorState === 'attached'
      ? mintRef({ ...after.anchor, keys: answer.keys || after.anchor?.keys || [] }, { writable: !!answer.writable })
      : null;
  return {
    ok: answer.anchorState === 'attached',
    targetRef,
    // How the element was identified, so an agent can tell "this is certainly
    // it" from "this is where it was".
    confidence: answer.confidence || null,
    targetEditable: !!targetRef && !!answer.writable,
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
    review: reviewOf(after),
    revision: store.revision,
  };
}

// --- wiring ------------------------------------------------------------------

/**
 * Register the renderer's door.
 *
 * Deliberately narrow. Nothing here takes a path: the file a review lives in is
 * derived from the project the main process has open, so a renderer cannot ask
 * this to read or write anywhere else in userData. The sharing channels take a
 * server address and an invitation, which are the two things a person types.
 */
function start({ userDataPath, send, protector = null }) {
  userData = userDataPath;
  sendToWindow = send || null;
  registry = registry || createWorkspaces({ userDataPath });
  // `protector` is injected by tests and only by tests. In the app it is
  // Electron's safeStorage; nothing automated ever reaches a real Keychain.
  secureRooms = secureRooms || createSecureRooms({ userDataPath, protector });
  syncer = syncer || createSyncer();
  if (registered) return;
  registered = true;

  ipcMain.handle('reviews:list', (_e, args) => list({ ...(args || {}), withSource: false }));
  ipcMain.handle('reviews:act', (_e, args) => act(args || {}));
  ipcMain.handle('reviews:remove', (_e, threadId) => remove(threadId));
  ipcMain.handle('reviews:recolor', (_e, args) => recolor(args?.threadId, args?.color));
  ipcMain.handle('reviews:editMessage', (_e, args) => editMessage(args || {}));
  ipcMain.handle('reviews:removeMessage', (_e, args) => removeMessage(args || {}));
  ipcMain.handle('reviews:syncAnchors', (_e, args) => syncAnchors(args));
  // Sharing. Every one of these is something a person did in the window.
  ipcMain.handle('reviews:shared', () => ({ ok: true, shared: sharedStatus() }));
  ipcMain.handle('reviews:sync', (_e, args) => syncNow(args?.reason || 'manual'));
  ipcMain.handle('reviews:sharedEnable', (_e, args) => enableShared(args || {}));
  ipcMain.handle('reviews:sharedJoin', (_e, args) => joinShared(args || {}));
  ipcMain.handle('reviews:sharedDisable', () => disableShared());
  ipcMain.handle('reviews:sharedInvite', (_e, args) => createInvite(args || {}));
  // Secure Share. Every one of these is a person doing something in the app's
  // own window: there is no MCP tool and no Agent API route that reaches any
  // of them, which is the same rule the legacy sharing verbs have and matters
  // more here because the thing behind them is a decryption key.
  ipcMain.handle('reviews:secureEnable', (_e, args) => enableSecureShare(args || {}));
  ipcMain.handle('reviews:secureInspect', (_e, args) => inspectInvite(args?.capability));
  ipcMain.handle('reviews:secureCancelJoin', () => cancelInvite());
  ipcMain.handle('reviews:secureJoin', (_e, args) => joinSecureShare(args || {}));
  ipcMain.handle('reviews:secureInvite', (_e, args) => createSecureInvite(args || {}));
  ipcMain.handle('reviews:secureLeave', () => leaveSecureShare());
  ipcMain.handle('reviews:secureEnd', () => endSecureShare());
  ipcMain.handle('reviews:secureRelay', (_e, args) => setSecureRelay(args || {}));
  ipcMain.handle('reviews:identity', () => identity());
  ipcMain.handle('reviews:setIdentity', (_e, args) => setIdentity(args || {}));
}

/**
 * An invitation arrived from the operating system.
 *
 * The deep link handler in main.js has already checked the URL; this checks
 * the capability itself and then asks a PERSON. Nothing joins on its own —
 * see joinSecureShare, which takes no capability argument precisely so that
 * the only room that can be joined is the one somebody was shown.
 */
function offerInvite(capability) {
  const looked = inspectInvite(capability);
  if (!looked.ok) return looked;
  sendToWindow?.('reviews:invite', looked.invite);
  return looked;
}

/** The MCP wiring, handing over the things only it has. */
function attach(parts = {}) {
  if (typeof parts.ask === 'function') ask = parts.ask;
  if (typeof parts.readPayload === 'function') readPayload = parts.readPayload;
  if (typeof parts.resolveTrail === 'function') resolveTrail = parts.resolveTrail;
  if (typeof parts.mintRef === 'function') mintRef = parts.mintRef;
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
  // sharing
  sharedStatus,
  syncNow,
  enableShared,
  joinShared,
  disableShared,
  createInvite,
  // secure share
  enableSecureShare,
  inspectInvite,
  cancelInvite,
  joinSecureShare,
  createSecureInvite,
  leaveSecureShare,
  endSecureShare,
  setSecureRelay,
  offerInvite,
  DEFAULT_RELAY,
  identity,
  setIdentity,
  noteAgent,
  agentName,
  FOCUS_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
};
