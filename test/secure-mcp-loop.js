// The whole point of the product, in one file.
//
//   npx electron test/secure-mcp-loop.js
//
// Everything else proves a segment. This proves the line:
//
//   Bob writes a review on his machine
//     → sealed, and pushed to a relay that cannot read it
//   Alice's Stacki pulls it and decrypts it
//     → it lands in her ledger as somebody else's comment
//   an agent connects to Alice over MCP
//     → finds that comment, is handed the node it is anchored to
//     → changes THAT node through Stacki's own writer
//     → photographs the result
//     → replies and resolves in the thread
//   Alice's Stacki seals the reply and pushes it
//   Bob pulls it and decrypts it
//     → the same thread, on his machine, with the agent's answer in it
//
// Every arrow is a real boundary here. The relay is a real HTTP server. The
// envelopes are really encrypted, and the last check in this file greps the
// relay's database for every word either side ever wrote. Alice is the shipped
// main process with a real project and a real MCP server; Bob is a second,
// fully separate participant — his own secret registry, his own ledger, his own
// actor — built from the same shipped modules, because two Electron apps cannot
// share one process and what matters is that he is a genuinely separate party
// holding genuinely separate keys.
//
// WHICH RELAY. A local one, started as a CHILD PROCESS — which is what a relay
// is, and not by choice alone: it uses `node:sqlite`, and the Node that
// Electron bundles does not have it. Requiring it in here takes the main
// process down with an uncaught ERR_UNKNOWN_BUILTIN_MODULE before any handler
// can catch it, which is a modal dialog on somebody's screen. So `node` off the
// PATH, over a real socket. test/secure-share-visual.js does the same, for the
// same reason.
//
// The hosted relay is not deployed — there are no Cloudflare credentials on
// this machine — so this proves the software end to end and says nothing about
// any hosted service.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { app, BrowserWindow, dialog } = require('electron');

process.env.STACKI_NO_DIALOGS = '1';

const { makeCanvasProject, removeCanvasProject, astroCached, sweepStaleRuns } = require('./agent-canvas-fixture.js');
const { ownedTempDir, releaseTempDir } = require('./support/ownedTemp.js');
const { projectFingerprint } = require('../electron/mcp/agent/refs.js');
const { createSecureRooms } = require('../electron/review/secure/secrets.js');
const { createSecureTransport, joinRoom } = require('../electron/review/secure/transport.js');
const { createReviewStore, fileFor } = require('../electron/review/store.js');
const { syncOnce } = require('../electron/review/sync.js');
const { uuidv5 } = require('../electron/review/actors.js');

// PUBLIC MODE. With STACKI_PUBLIC_RELAY set, this same proof runs against a
// deployed relay over the internet instead of a relay spawned here — same
// clients, same protocol, same assertions, one more hop and a real TLS
// termination in the middle. Unset, it behaves exactly as before.
const PUBLIC_RELAY = (process.env.STACKI_PUBLIC_RELAY || '').replace(/\/+$/, '');

// DEFAULT MODE. With STACKI_DEFAULT_RELAY_PATH=1 and no explicit relay, this
// proves the thing a person actually does: press Share… and have it work. The
// app resolves its own DEFAULT_RELAY, nothing is injected, and the room's
// relay is asserted to be that constant afterwards. It is the only mode that
// can catch a default pointing somewhere that does not answer.
const DEFAULT_PATH = process.env.STACKI_DEFAULT_RELAY_PATH === '1';
const { DEFAULT_RELAY } = require('../electron/review/secure/relays.js');
if (PUBLIC_RELAY || DEFAULT_PATH) require('./support/publicFetch.js').usePublicNetwork();

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const say = (t) => process.stdout.write(`${t}\n`);
const shout = (t) => process.stderr.write(`${t}\n`);
const short = (x, n = 220) => JSON.stringify(x ?? null).slice(0, n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, { timeout = 90000, every = 250 } = {}) {
  const stop = Date.now() + timeout;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what}`);
    await wait(every);
  }
}

if (!astroCached() && process.env.STACKI_CANVAS_OFFLINE) {
  say('secure-mcp-loop: skipped (no astro cache and STACKI_CANVAS_OFFLINE is set)');
  process.exit(0);
}

const swept = sweepStaleRuns(['stacki-canvas-', 'stacki-loop-']);
for (const s of swept.swept) say(`secure-mcp-loop: swept ${s.name} (dead ${s.harness} pid ${s.pid})`);

// Words that exist nowhere else, so finding one anywhere is unambiguous.
const BOB_SAYS = 'LOOP-CANARY-bob-asked-for-this-9c1f';
const AGENT_SAYS = 'LOOP-CANARY-agent-answered-4d7e';
const NEW_TEXT = 'We are here for you';

const root = makeCanvasProject({ harness: 'secure-mcp-loop', log: (m) => say(`secure-mcp-loop: ${m}`) });
const userData = ownedTempDir('stacki-loop-alice-', { harness: 'secure-mcp-loop' });
const bobData = ownedTempDir('stacki-loop-bob-', { harness: 'secure-mcp-loop' });
const bobProject = ownedTempDir('stacki-loop-bobproj-', { harness: 'secure-mcp-loop' });
const relayData = ownedTempDir('stacki-loop-relay-', { harness: 'secure-mcp-loop' });
app.setPath('userData', userData);

/**
 * A free port, synchronously — the relay's address has to be known before
 * main.js is required, and nothing can be awaited yet. A throwaway node
 * process is the least clever way to ask the operating system for one.
 */
const RELAY_PORT = Number(
  execFileSync('node', ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))})"], {
    encoding: 'utf8',
  }).trim()
);

fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ sound: false, agentAccess: { [projectFingerprint(root)]: 'edit' } }, null, 2),
  'utf8'
);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });

const mcp = require('../electron/mcp');
require('../electron/main.js');

const BOB = { id: uuidv5('loop-bob'), kind: 'human', displayName: 'Bob' };
const NO_GIT = { branch: null, commit: null, remote: null, dirty: false };
// A protector that keeps secrets the way a machine with no keyring does: in the
// 0600 file. Bob is not an Electron app, so he has no safeStorage.
const bobProtector = { available: false, protects: false, backend: 'file' };

let relay = null;
let stopPreview = null;

function makeClient({ url, token }) {
  let id = 0;
  const post = (body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const parse = async (res) => {
    const text = await res.text();
    if (!text.trim()) return null;
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line ? line.replace(/^data:\s*/, '') : text);
  };
  const request = async (method, params) => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) });
    return { status: res.status, body: await parse(res) };
  };
  return {
    request,
    notify: async (method) => (await post({ jsonrpc: '2.0', method })).status,
    async call(name, args) {
      const { body } = await request('tools/call', { name, arguments: args });
      if (body?.error) return { ok: false, code: 'rpc_error', message: JSON.stringify(body.error) };
      return body?.result?.structuredContent ?? { ok: false, code: 'no_content' };
    },
    async callWithImage(name, args) {
      const { body } = await request('tools/call', { name, arguments: args });
      return { meta: body?.result?.structuredContent || {}, image: (body?.result?.content || []).find((c) => c.type === 'image') || null };
    },
  };
}

(async () => {
  // --- a relay that cannot read anything ------------------------------------

  const relayBase = DEFAULT_PATH ? DEFAULT_RELAY : PUBLIC_RELAY || `http://127.0.0.1:${RELAY_PORT}`;
  if (DEFAULT_PATH) {
    say(`\nsecure-mcp-loop: DEFAULT relay path — nothing injected, the app picks ${DEFAULT_RELAY}`);
    const up = await fetch(`${DEFAULT_RELAY}/health`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json()).catch(() => null);
    check('the relay the app defaults to is answering', up?.ok === true, JSON.stringify(up));
  } else if (PUBLIC_RELAY) {
    say(`\nsecure-mcp-loop: PUBLIC relay ${relayBase}`);
    const up = await fetch(`${relayBase}/health`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json()).catch(() => null);
    check('the deployed relay is answering before anything is asked of it', up?.ok === true, JSON.stringify(up));
  } else {
  relay = spawn('node', ['--disable-warning=ExperimentalWarning', 'relay/node/bin.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STACKI_RELAY_PORT: String(RELAY_PORT), STACKI_RELAY_DATA: relayData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relayLog = [];
  relay.stdout?.on('data', (d) => relayLog.push(String(d)));
  relay.stderr?.on('data', (d) => relayLog.push(String(d)));
  relay.on('error', (err) => shout(`  the relay could not start: ${err.message}`));
  await until('the relay to answer', async () => {
    try {
      return (await fetch(`${relayBase}/health`, { signal: AbortSignal.timeout(1200) })).ok;
    } catch {
      return false;
    }
  }, { timeout: 30000 });
  say(`\nsecure-mcp-loop: relay on ${relayBase}`);
  }

  await app.whenReady();
  const status = await until('the MCP server', () => {
    const s = mcp.status();
    return s.running ? s : null;
  });
  const window_ = await until('the app window', () => BrowserWindow.getAllWindows()[0] || null);
  await until('the window to load', () => (window_.webContents.isLoading() ? null : true), { timeout: 60000 });
  await wait(500);
  window_.webContents.send('menu:openProject');

  const client = makeClient({ url: status.url, token: status.token });
  const inRenderer = (expr) => window_.webContents.executeJavaScript(expr, true);

  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'stacki-secure-mcp-loop', version: '1.0.0' },
  });
  await client.notify('notifications/initialized');

  await until(
    'the preview to render',
    async () => {
      const ctx = await client.call('get_context', { styleDetail: 'none' });
      return ctx.project?.root && ctx.selection?.status === 'ready' ? ctx : null;
    },
    { timeout: 180000 }
  );
  stopPreview = () => client.call('project', { action: 'dev_stop' });

  // --- Alice shares, Bob joins ----------------------------------------------

  say('  1  Alice starts a secure share, Bob joins');
  // In default mode the call carries NO relay, exactly as the Share… button
  // sends it — whatever happens next is the shipped default doing its job.
  const enableArgs = DEFAULT_PATH ? '{ publishExisting: false }' : `{ relay: ${JSON.stringify(relayBase)}, publishExisting: false }`;
  const enabled = JSON.parse(
    await inRenderer(`
      (async () => JSON.stringify(await window.avb.reviewsSecureEnable(${enableArgs})))()
    `)
  );
  check('Alice starts a secure share against the relay', enabled?.ok === true, short(enabled));
  if (DEFAULT_PATH) {
    // `secure.relay` is the relay THIS ROOM uses — deliberately a different
    // field from the preference for future shares, so neither can be read as
    // the other. That is the one to assert.
    // `secure.relay` is a describeRelay() object, not a string: its `.origin`
    // is the address and its `.label` is what a person is shown.
    const roomRelay = enabled?.shared?.secure?.relay;
    check('  with no relay named by anybody but the app itself', roomRelay?.origin === DEFAULT_RELAY, `${roomRelay?.origin} vs ${DEFAULT_RELAY}`);
    check('  and it is presented as a hosted relay, not as Stacki’s own', roomRelay?.label === 'Hosted relay', String(roomRelay?.label));
  }

  const invited = JSON.parse(await inRenderer('(async () => JSON.stringify(await window.avb.reviewsSecureInvite({})))()'));
  const capability = invited?.capability || null;
  check('and gets an invitation', typeof capability === 'string' && capability.startsWith('stacki2.'), short(invited).slice(0, 120));
  if (DEFAULT_PATH) {
    const { unpackCapability } = require('../electron/review/secure/capability.js');
    check('  whose capability points at the default relay', unpackCapability(capability)?.relay === DEFAULT_RELAY, String(unpackCapability(capability)?.relay));
  }

  // Bob is a genuinely separate party: his own registry, ledger and actor.
  const bobRooms = createSecureRooms({ userDataPath: bobData, protector: bobProtector });
  const joined = await joinRoom({ capability, actor: BOB, rooms: bobRooms });
  check('Bob joins with it', joined.ok === true, short(joined));
  const bobRoomId = joined.room?.roomId;
  const bobStore = createReviewStore({ file: fileFor(bobData, bobProject), projectPath: bobProject, actor: BOB, source: NO_GIT });
  bobStore.enableShared({ workspaceId: bobRoomId, publishExisting: false });
  const bobLink = {
    kind: 'secure',
    id: bobRoomId,
    actorId: BOB.id,
    make: () => createSecureTransport({ rooms: bobRooms, roomId: bobRoomId }),
  };
  const bobSync = (reason = 'manual') => syncOnce({ store: bobStore, link: bobLink, reason });

  // --- Bob leaves a review ---------------------------------------------------

  say('  2  Bob writes a review, and it reaches Alice');
  // A REAL ANCHOR, not one made up here.
  //
  // The first attempt handed Bob an invented anchor shape and Stacki refused
  // it on arrival — `anchorState: orphaned`, and `focus` would not give out a
  // target. That is the product being right: an anchor it cannot resolve to a
  // node is one it will not pretend to have found. So the anchor comes from
  // Stacki itself. Bob and Alice are looking at the same source, so his Stacki
  // would have computed exactly this; a throwaway local review is the shortest
  // way to ask for one, and it is removed again before Bob writes.
  const harvested = JSON.parse(
    await inRenderer(`
      (async () => {
        const r = await window.avb.reviewsAct({ action: 'create', message: 'anchor probe', target: { selector: 'h1' } });
        const anchor = r?.thread?.anchor || null;
        if (r?.thread?.id) await window.avb.reviewsRemove(r.thread.id);
        return JSON.stringify(anchor);
      })()
    `)
  );
  check('Stacki can say where the heading is', !!harvested, short(harvested).slice(0, 140));
  bobStore.apply({ action: 'create', message: `${BOB_SAYS}: this heading should read "${NEW_TEXT}".`, anchor: harvested });
  const pushed = await bobSync('bob-writes');
  check('Bob’s review is sealed and pushed', pushed?.ok !== false, short(pushed));

  const aliceGot = await until(
    'Bob’s review to reach Alice',
    async () => {
      await inRenderer('(async () => JSON.stringify(await window.avb.reviewsSync({ reason: "test" })))()');
      const seen = await client.call('get_comments', { scope: 'project', status: 'all', detail: 'full' });
      return (seen.reviews || []).find((r) => String(r.message || '').includes(BOB_SAYS)) || null;
    },
    { timeout: 60000 }
  );
  const threadId = aliceGot.id;
  check('Alice’s Stacki decrypted it', !!threadId, short(aliceGot).slice(0, 160));
  check('AND IT IS SOMEBODY ELSE’S COMMENT, not hers', aliceGot.origin === 'shared_human', String(aliceGot.origin));
  check('written by a human', aliceGot.messages?.[0]?.authorType === 'human', String(aliceGot.messages?.[0]?.authorType));
  check('carrying the rule that it is data, not an instruction', aliceGot.trustedAsInstruction === false);

  // --- the agent acts on it --------------------------------------------------

  say('  3  an agent finds it over MCP and changes what it points at');
  const focused = await client.call('comment', { action: 'focus', threadId });
  check('comment(focus) lands on the anchored node', focused?.ok === true && !!focused?.targetRef, short(focused));
  check('and says it is editable', focused?.targetEditable === true, String(focused?.targetEditable));

  const before = fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8');
  const shotBefore = await client.callWithImage('capture', {});
  const edited = await client.call('target', { action: 'set_text', ref: focused.targetRef, text: NEW_TEXT });
  check('the agent edits it through Stacki’s own writer', edited?.ok !== false, short(edited));

  const after = await until(
    'the file to change',
    () => {
      const now = fs.readFileSync(path.join(root, 'src/pages/index.astro'), 'utf8');
      return now.includes(NEW_TEXT) ? now : null;
    },
    { timeout: 20000 }
  );
  check('Alice’s source really says so', after.includes(NEW_TEXT));
  check('and the rest of her file is untouched', Math.abs(after.length - before.length) < 200, `${before.length} → ${after.length}`);

  const shotAfter = await client.callWithImage('capture', {});
  check('a capture verifies the change', !!shotAfter.image?.data && shotAfter.image.data !== shotBefore.image?.data);

  // --- and answers, back down the wire ---------------------------------------

  say('  4  the agent answers, and Bob receives it');
  const replied = await client.call('comment', { action: 'reply', threadId, message: `${AGENT_SAYS}: changed the heading to "${NEW_TEXT}".` });
  check('the agent replies in the thread', replied?.ok === true, short(replied));
  const resolvedOut = await client.call('comment', { action: 'resolve', threadId });
  check('and resolves it', resolvedOut?.ok === true, short(resolvedOut));

  await inRenderer('(async () => JSON.stringify(await window.avb.reviewsSync({ reason: "test" })))()');

  const bobSees = await until(
    'the agent’s answer to reach Bob',
    async () => {
      await bobSync('bob-pulls');
      const one = bobStore.all().find((r) => r.id === threadId) || null;
      return one && (one.messages || []).some((m) => String(m.body || m.message || '').includes(AGENT_SAYS)) ? one : null;
    },
    { timeout: 60000 }
  );
  check('BOB RECEIVES THE AGENT’S REPLY', !!bobSees, short(bobSees).slice(0, 160));
  check('on the very same thread he started', bobSees.id === threadId);
  check('and his Stacki knows an agent wrote it', (bobSees.messages || []).some((m) => (m.author?.kind || m.authorType) === 'agent'), short((bobSees.messages || []).map((m) => m.author?.kind || m.authorType)));
  check('his own first message is still his', (bobSees.messages || [])[0] && ((bobSees.messages[0].author?.kind || bobSees.messages[0].authorType) === 'human'));
  check('and the thread is resolved on his machine too', bobSees.status === 'resolved', String(bobSees.status));

  // --- what the relay saw ----------------------------------------------------

  say('  5  what the relay was able to read');
  // WHERE THE EVIDENCE LIVES DEPENDS ON WHOSE DISK IT IS.
  //
  // Against a local relay this reads the SQLite FILE byte for byte, which is
  // the strongest form of the claim: everything the relay could hand anyone,
  // including whatever a query might have hidden. Against a deployed Durable
  // Object there is no such file within reach, and Cloudflare offers no
  // supported way to read a DO's raw storage from outside. Adding an endpoint
  // that dumped it would create exactly the hole this test exists to disprove,
  // so the deployed run says plainly which proof it is making.
  let wholeDb = '';
  if (PUBLIC_RELAY || DEFAULT_PATH) {
    say('    (deployed: raw Durable Object storage is not externally readable —');
    say('     the byte-level proof is the local run; this run proves the wire)');
    // What CAN be checked from here is everything that crossed the network.
    wholeDb = '';
  } else {
    const dbFile = path.join(relayData, 'relay.db');
    check('the relay wrote a database', fs.existsSync(dbFile), dbFile);
    wholeDb = fs.readFileSync(dbFile).toString('latin1');
    check('and it is holding something', wholeDb.length > 1000, `${wholeDb.length} bytes`);
  }
  if (!PUBLIC_RELAY && !DEFAULT_PATH) {
    for (const [what, secret] of [
      ['what Bob wrote', BOB_SAYS],
      ['what the agent answered', AGENT_SAYS],
      ['the text the agent set', NEW_TEXT],
      ['the source file the review points at', 'index.astro'],
      ['Bob’s display name', 'Bob'],
      ['Alice’s project path', root],
    ]) {
      check(`the relay never received ${what}`, !wholeDb.includes(secret), what);
    }
  }

  // The thread is on both machines. Ending the share does not take it away.
  const ended = JSON.parse(await inRenderer('(async () => JSON.stringify(await window.avb.reviewsSecureEnd()))()'));
  check('Alice can end the share', ended?.ok === true, short(ended));
  const afterEnd = await client.call('get_comments', { scope: 'project', status: 'all', detail: 'summary' });
  check('and the conversation stays on her machine', (afterEnd.reviews || []).some((r) => r.id === threadId), short((afterEnd.reviews || []).map((r) => r.id)));
  check('as it does on his', !!bobStore.all().find((r) => r.id === threadId));

  await finish(0);
})().catch(async (err) => {
  shout(`secure-mcp-loop: threw\n${err?.stack || err}`);
  failures.push(`  the run did not finish: ${err?.message || err}`);
  await finish(1);
});

let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  const problems = [];
  try {
    if (stopPreview) await stopPreview();
  } catch (err) {
    problems.push(`stopping the preview: ${err.message}`);
  }
  try {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  } catch {
    /* gone */
  }
  try {
    await mcp.stopMcp();
  } catch (err) {
    problems.push(`stopping MCP: ${err.message}`);
  }
  try {
    if (!PUBLIC_RELAY && !DEFAULT_PATH && relay && relay.exitCode === null) {
      const gone = new Promise((resolve) => relay.once('exit', resolve));
      relay.kill('SIGTERM');
      await Promise.race([gone, wait(4000)]);
      if (relay.exitCode === null) relay.kill('SIGKILL');
      await wait(300);
    }
  } catch (err) {
    problems.push(`stopping the relay: ${err.message}`);
  }
  await wait(400);
  try {
    removeCanvasProject(root);
  } catch (err) {
    problems.push(`removing the project: ${err.message}`);
  }
  for (const [name, dir] of [
    ['Alice’s userData', userData],
    ['Bob’s userData', bobData],
    ['Bob’s project', bobProject],
    ['the relay’s data', relayData],
  ]) {
    if (!releaseTempDir(dir)) problems.push(`${name} would not go`);
  }

  if (problems.length) {
    shout(`\nsecure-mcp-loop: could not clean up\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
    code = code || 1;
  }
  if (failures.length) {
    shout(`\nsecure-mcp-loop: ${failures.length} failed, ${checked - failures.length} passed\n`);
    shout(failures.join('\n') + '\n');
    code = code || 1;
  } else if (!code) {
    say(`\nsecure-mcp-loop: ${checked} checks passed  [Bob → relay → Alice → MCP → agent → relay → Bob]`);
  }
  app.exit(code);
}
