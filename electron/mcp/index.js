// Stacki's MCP server, wired into the app.
//
// Everything that needs Electron is here; the endpoint, the normalizer, the
// crop arithmetic and the tool surface are all plain modules beside this one.
//
// The shape is push for what changes and pull for what costs something. The
// renderer publishes a snapshot whenever the selection, the page or the
// breakpoint moves — cheap, and it is what gives `revision` its meaning. The
// two expensive answers, an element's computed style and a picture of it, are
// asked for at the moment a tool is called, because both are questions only
// the live page can answer and neither is worth carrying around.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { app, ipcMain } = require('electron');

const { locateSelection } = require('../astroParser');
const { selectionTrail } = require('../selectionTrail');
const { createContextStore } = require('./contextStore');
const { propertiesFor, pickEssential, allStyles } = require('./essentialStyles');
const { createCapture } = require('./capture');
const { createStackiMcpServer, DEFAULT_PORT } = require('./server');
const reviews = require('../review');

// How long the renderer gets to answer. Long enough for a busy canvas to
// measure and paint a frame, short enough that a wedged page returns a status
// rather than hanging the agent that asked.
const ASK_TIMEOUT_MS = 4000;
const CAPTURE_TIMEOUT_MS = 8000;

const TOKEN_FILE = 'mcp-token.json';

// --- token ------------------------------------------------------------------

const tokenPath = () => path.join(app.getPath('userData'), TOKEN_FILE);

/**
 * The bearer token, made once and kept in the app's own data directory.
 *
 * Never in the opened project, never in package.json, never in a config file
 * this app writes on somebody's behalf — the token is the whole of the
 * security model, and the one place it must not be is anywhere that gets
 * committed.
 */
function readOrCreateToken() {
  const file = tokenPath();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved.token === 'string' && saved.token.length >= 32) return saved.token;
  } catch {
    /* no token yet, or an unreadable one — make a new one */
  }
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600); // an existing file keeps its old mode through writeFileSync
  } catch (err) {
    // A token that cannot be stored still works for this run; the next launch
    // makes another and the user re-copies it.
    console.warn('[stacki] could not store the MCP token:', err.message);
  }
  return token;
}

// --- the renderer, asked a question -----------------------------------------

let asking = new Map();
let nextAskId = 1;

function createAsker(getWindow) {
  return function ask(kind, params, timeoutMs = ASK_TIMEOUT_MS) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    const id = nextAskId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        asking.delete(id);
        resolve(null);
      }, timeoutMs);
      asking.set(id, (value) => {
        clearTimeout(timer);
        asking.delete(id);
        resolve(value);
      });
      try {
        win.webContents.send('mcp:ask', { id, kind, params });
      } catch {
        clearTimeout(timer);
        asking.delete(id);
        resolve(null);
      }
    });
  };
}

// --- the server -------------------------------------------------------------

let running = null; // the started server
let state = { running: false, url: null, port: null, error: null };
let store = null;
let handlersRegistered = false;

/** What the settings/status surface shows. Includes the token, which the app's own window may display. */
function status() {
  return { ...state, token: state.running ? running?.token || null : null };
}

function resolvePort(settings) {
  const fromEnv = Number(process.env.STACKI_MCP_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  const fromSettings = Number(settings?.mcpPort);
  if (Number.isInteger(fromSettings) && fromSettings > 0 && fromSettings < 65536) return fromSettings;
  return DEFAULT_PORT;
}

/**
 * Start the MCP server and wire the renderer to it.
 *
 * `getWindow()` answers with the app window — the one whose canvas is being
 * described and photographed.
 */
async function startMcp({ getWindow, version = '0.0.0', settings = {} } = {}) {
  store = store || createContextStore({ resolveTrail: (keys) => resolveTrail(keys) });
  let projectRoot = null;

  // The trail resolver needs the project the snapshot is about, which arrives
  // with the payload — held here so the store can stay a pure function of it.
  function resolveTrail(keys) {
    if (!projectRoot || !Array.isArray(keys)) return null;
    return selectionTrail({ projectPath: projectRoot, keys }, locateSelection);
  }

  const ask = createAsker(getWindow);

  // The last payload as the renderer sent it, kept beside the normalized
  // snapshot rather than instead of it. Visual Review anchors a comment to the
  // selection KEYS, which normalizing deliberately resolves away into file:line
  // — and a review that anchored to lines would come unstuck the first time
  // somebody typed above it. Same object, two readers, no second source of
  // truth about what is selected.
  let lastPayload = null;

  if (!handlersRegistered) {
    handlersRegistered = true;

    ipcMain.handle('mcp:publish', (_e, payload) => {
      projectRoot = payload?.project?.root || null;
      lastPayload = projectRoot ? payload : null;
      if (!projectRoot) return store.reset();
      return store.publish(payload);
    });

    ipcMain.handle('mcp:status', () => status());

    ipcMain.handle('mcp:reply', (_e, reply) => {
      const settle = asking.get(reply?.id);
      if (settle) settle(reply?.value ?? null);
      return { ok: true };
    });
  }

  // --- the two tools --------------------------------------------------------

  async function getContext({ styleDetail }) {
    const snapshot = store.read();
    if (styleDetail === 'none' || snapshot.selection.status !== 'ready') return snapshot;
    // The essential list is named here; for `full` the renderer adds whatever
    // else the engine knows about, since only a document can enumerate that.
    const answer = await ask('styles', {
      detail: styleDetail,
      properties: propertiesFor(styleDetail),
    });
    if (!answer || !answer.computed) return snapshot;
    const essential = pickEssential(answer.computed);
    if (essential) snapshot.selection.essentialComputedStyles = essential;
    if (styleDetail === 'full') {
      const every = allStyles(answer.computed);
      if (every) snapshot.selection.computedStyles = every;
    }
    return snapshot;
  }

  const capture = createCapture({
    getWindow,
    ask,
    readSnapshot: () => store.read(),
    captureTimeoutMs: CAPTURE_TIMEOUT_MS,
  });

  // --- and the two review tools ---------------------------------------------
  //
  // The ledger is the app's, not MCP's, so this hands it the two things only
  // the MCP wiring has: the renderer round-trip (for `focus`, which moves the
  // live app) and the published payload (for `create`, which anchors to what is
  // on screen). Everything else it does on its own.
  reviews.attach({ ask, readPayload: () => lastPayload, resolveTrail: (keys) => resolveTrail(keys) });

  async function getComments({ status, scope, detail, limit }) {
    // Which page and which element "page" and "selection" scope mean: the ones
    // the snapshot is describing, so an agent's scope and its get_context can
    // never be about different things.
    const snapshot = store.read();
    return reviews.list({
      status,
      scope,
      detail,
      limit,
      page: snapshot.page,
      keys: lastPayload?.selection?.keys || null,
    });
  }

  async function comment(args) {
    if (args?.action === 'focus') return reviews.focus(args.threadId);
    return reviews.act({ ...args, authorType: 'agent' });
  }

  // --- listen ---------------------------------------------------------------

  if (process.env.STACKI_MCP === 'off') {
    state = { running: false, url: null, port: null, error: 'Disabled by STACKI_MCP=off.' };
    return state;
  }

  const port = resolvePort(settings);
  const token = readOrCreateToken();
  const server = createStackiMcpServer({
    port,
    token,
    version,
    getContext,
    capture,
    getComments,
    comment,
    onError: (err) => console.warn('[stacki] MCP:', err?.message || err),
  });
  try {
    await server.start();
    running = server;
    running.token = token;
    state = { running: true, url: server.url, port, error: null };
  } catch (err) {
    running = null;
    state = { running: false, url: null, port, error: err.message };
    console.warn('[stacki] MCP server did not start:', err.message);
  }
  return state;
}

async function stopMcp() {
  const server = running;
  running = null;
  state = { running: false, url: null, port: state.port, error: state.error };
  for (const settle of asking.values()) settle(null);
  asking = new Map();
  if (server) await server.stop().catch(() => {});
}

/** Nothing is open — the snapshot goes back to a cold start. */
function resetContext() {
  store?.reset();
}

module.exports = { startMcp, stopMcp, status, resetContext, readOrCreateToken, tokenPath };
