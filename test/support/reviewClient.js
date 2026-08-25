// One Stacki installation, without Stacki.
//
// Driven over stdin/stdout by test/shared-acceptance.js, which runs two of
// these at once against one reference service. Two PROCESSES rather than two
// objects, because that is what two installations are: separate userData,
// separate identity, separate ledger, separate lamport clock, separate
// everything. Two instances in one process would share module state and would
// quietly pass tests that a real pair of laptops fails.
//
// `electron` is stubbed to the one thing the module touches at load —
// `ipcMain.handle` — so the REAL electron/review/index.js runs here, the same
// file the app runs. A driver that reimplemented any of it would be testing
// itself.
//
// Protocol: one JSON object per line in, one per line out.
//   in   { "id": 1, "op": "open", "args": { "projectPath": "/tmp/x" } }
//   out  { "id": 1, "ok": true, "result": ... }

const Module = require('node:module');

const handlers = new Map();
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
  }
  return realLoad.call(this, request, ...rest);
};

const reviews = require('../../electron/review/index.js');

// What the renderer normally publishes on every selection change. The anchor a
// comment is built from comes from this, so a comment made here is built by
// exactly the code path a click in the app goes down.
let payload = null;

const OPS = {
  start({ userDataPath }) {
    reviews.start({ userDataPath, send: () => {} });
    // The two things the MCP wiring normally hands over. `resolveTrail` is
    // stubbed because it needs the Astro parser and a project on disk; nothing
    // in this scenario is about line numbers.
    reviews.attach({ readPayload: () => payload, resolveTrail: () => null });
    return { ok: true };
  },
  payload({ value }) {
    payload = value;
    return { ok: true };
  },
  open({ projectPath }) {
    reviews.openProject(projectPath);
    return { ok: true };
  },
  close() {
    reviews.closeProject();
    return { ok: true };
  },
  identity() {
    return reviews.identity();
  },
  setIdentity({ displayName }) {
    return reviews.setIdentity({ displayName });
  },
  list(args) {
    return reviews.list({ status: 'all', scope: 'project', detail: 'full', limit: 200, ...args });
  },
  act(args) {
    return reviews.act(args);
  },
  syncAnchors({ updates }) {
    return reviews.syncAnchors(updates);
  },
  shared() {
    return { ok: true, shared: reviews.sharedStatus() };
  },
  sync({ reason }) {
    return reviews.syncNow(reason || 'manual');
  },
  enable(args) {
    return reviews.enableShared(args);
  },
  join(args) {
    return reviews.joinShared(args);
  },
  disable() {
    return reviews.disableShared();
  },
  invite(args) {
    return reviews.createInvite(args || {});
  },
  /** Which IPC channels the module registered, so the app's door is covered too. */
  channels() {
    return { ok: true, channels: [...handlers.keys()] };
  },
  /** Call one of them the way the preload does, rather than the export. */
  via({ channel, args }) {
    const handler = handlers.get(channel);
    if (!handler) return { ok: false, code: 'no_channel', message: channel };
    return handler(null, args);
  },
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: `bad command: ${err.message}` })}\n`);
      continue;
    }
    if (message.op === 'quit') {
      reviews.flushSync();
      process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result: { ok: true } })}\n`);
      process.exit(0);
    }
    const op = OPS[message.op];
    if (!op) {
      process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: `unknown op ${message.op}` })}\n`);
      continue;
    }
    try {
      const result = await op(message.args || {});
      process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: err?.stack || String(err) })}\n`);
    }
  }
});
