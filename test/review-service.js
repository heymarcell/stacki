// The service that sits between the ledger and everything that talks to it.
//
//   node test/review-service.js
//
// electron/review/index.js is the module the IPC handlers and the MCP tools
// both call. It had no test, and the reason is the reason it needed one: it
// starts with `require('electron')`, so nothing could load it without an
// Electron process — and "cannot be loaded in a test" quietly became "is not
// checked at all".
//
// What that cost: a refactor moved the read projection into the store and
// tidied the import list, dropping `detail` and `summarize` from it. Every
// mutation still called them. The store did its work and persisted it, and
// THEN the response threw a ReferenceError on the way out — so every edit
// landed and every edit showed an error. The panel tests passed, the store
// tests passed, the MCP tests passed, because none of them load this file.
//
// So `electron` is stubbed and the real module is exercised. These are not
// deep behavioural tests — the store has those — they are the checks that
// every door in this module opens onto something that exists.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// Only `ipcMain.handle` is reached at load; the window is handed over later.
const handlers = new Map();
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } };
  }
  return realLoad.call(this, request, ...rest);
};

const reviews = require('../electron/review/index.js');
const { anchorFrom } = require('../electron/review/anchor.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-svc-project-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-svc-userdata-'));

const payload = () => ({
  project: { root: ROOT },
  page: { route: '/', file: path.join(ROOT, 'src/pages/index.astro') },
  view: { device: 'desktop', viewportWidth: 1280, viewportHeight: 800 },
  preview: { status: 'on' },
  selection: {
    present: true,
    nodeKind: 'element',
    tag: 'section',
    occurrence: 0,
    occurrenceCount: 1,
    keys: ['src/pages/index.astro#0.1'],
    componentChain: ['index'],
    breadcrumbs: ['index', 'section'],
    peers: [{ index: 0, count: 1 }],
    text: 'Hello world',
    rect: { x: 0, y: 0, w: 10, h: 10 },
  },
});

const announced = [];
reviews.start({ userDataPath: userData, send: (channel, args) => announced.push([channel, args]) });
reviews.attach({
  readPayload: () => payload(),
  resolveTrail: (keys) => (keys || []).map((k) => ({ file: k.split('#')[0], startLine: 1, endLine: 2 })),
});

check('every IPC channel the preload invokes is registered', ['reviews:list', 'reviews:act', 'reviews:remove', 'reviews:editMessage', 'reviews:removeMessage', 'reviews:syncAnchors'].every((c) => handlers.has(c)), [...handlers.keys()].join());

// Nothing open yet.
check('with no project open, a read still answers in the promised shape', (() => {
  const empty = reviews.list({});
  return empty.ok === false && Array.isArray(empty.reviews) && empty.total === 0 && empty.truncated === false;
})(), JSON.stringify(reviews.list({})));
check('and a mutation refuses by name', reviews.act({ action: 'create', message: 'x' }).code === 'no_project');

reviews.openProject(ROOT);

// ── Every door, through the handlers the preload actually calls ─────────────
//
// Called through `handlers`, not the exported functions, because the handler
// is what the app reaches: a channel wired to the wrong function would pass a
// direct call and fail in the window.
const via = (channel, args) => handlers.get(channel)(null, args);

const made = via('reviews:act', { action: 'create', message: 'The hero padding is wrong.', authorType: 'human' });
check('create answers ok', made.ok === true, JSON.stringify(made));
check('and with the review, not just an id', !!made.review && made.review.id === made.thread.id, JSON.stringify(Object.keys(made)));
check('the review is the full projection', Array.isArray(made.review.messages) && !!made.review.anchor, JSON.stringify(Object.keys(made.review || {})));
check('and it carries where it points right now', Array.isArray(made.review.anchor.sourceTrail), JSON.stringify(made.review.anchor.sourceTrail));
check('the window was told something changed', announced.some(([c]) => c === 'reviews:changed'), JSON.stringify(announced.map(([c]) => c)));

const id = made.review.id;
const messageId = made.review.messages[0].id;

const replied = via('reviews:act', { action: 'reply', threadId: id, message: 'Reduced it to 12px.', authorType: 'agent' });
check('reply answers ok with the review', replied.ok === true && replied.review.messages.length === 2, JSON.stringify(replied.code || replied.review?.messages?.length));

const edited = via('reviews:editMessage', { threadId: id, messageId, message: 'The hero padding is wrong on mobile.' });
check('editMessage answers ok', edited.ok === true, JSON.stringify(edited));
check('and hands back the thread as it now reads', edited.review?.messages?.[0]?.body === 'The hero padding is wrong on mobile.', JSON.stringify(edited.review?.messages?.[0]));
check('and says it was edited', typeof edited.review.messages[0].editedAt === 'number');

const agentMessage = edited.review.messages[1].id;
const notYours = via('reviews:editMessage', { threadId: id, messageId: agentMessage, message: 'I said no such thing' });
check('an agent’s message cannot be reworded through the service either', notYours.ok === false && notYours.code === 'not_yours', JSON.stringify(notYours));

const pruned = via('reviews:removeMessage', { threadId: id, messageId: agentMessage });
check('removeMessage answers ok', pruned.ok === true, JSON.stringify(pruned));
check('and hands back the shortened thread', pruned.review?.messages?.length === 1, String(pruned.review?.messages?.length));

const last = via('reviews:removeMessage', { threadId: id, messageId });
check('the only message is refused, by name', last.ok === false && last.code === 'last_message', JSON.stringify(last));

// The channel a filing colour was set through. Gone with the colour, and gone
// means unregistered rather than answering with an error — a preload that
// still invoked it would be a renderer talking to nothing.
check('there is no recolour channel left to invoke', !handlers.has('reviews:recolor'), [...handlers.keys()].join());

const synced = via('reviews:syncAnchors', [{ id, anchorState: 'orphaned' }]);
check('syncAnchors answers ok', synced.ok === true && synced.changed === 1, JSON.stringify(synced));

const listed = via('reviews:list', { status: 'all', detail: 'full' });
check('list answers ok', listed.ok === true, JSON.stringify(listed.code));
check('with the review in it', listed.reviews.length === 1 && listed.reviews[0].id === id);
check('and every field the schema promises', ['total', 'returned', 'truncated', 'problem', 'revision'].every((k) => k in listed), JSON.stringify(Object.keys(listed)));
check('a summary read is the other projection', via('reviews:list', { status: 'all', detail: 'summary' }).reviews[0].messages === undefined);

const removed = via('reviews:remove', id);
check('remove answers ok', removed.ok === true, JSON.stringify(removed));
check('and it is gone', via('reviews:list', { status: 'all' }).reviews.length === 0);

// The ledger is a real file in userData, and nothing was written into the
// project — which is the rule this feature was built under.
const ledgerDir = path.join(userData, 'reviews');
check('the ledger lives in userData', fs.existsSync(ledgerDir) && fs.readdirSync(ledgerDir).some((f) => f.endsWith('.json')), fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).join() : 'no dir');
check('and nothing was written into the project', fs.readdirSync(ROOT).length === 0, fs.readdirSync(ROOT).join());

// ── The shared status, against the schema MCP publishes for it ──────────────
//
// `sharedStatus()` is one object with two consumers: the renderer over IPC,
// and `get_comments` over MCP. The MCP side declares its shape by hand in
// electron/mcp/reviewTools.js, and a hand-maintained mirror drifts — this has
// now broken twice.
//
// It is not a soft failure. The SDK turns that Zod schema into JSON Schema
// with `additionalProperties: false` and the CLIENT validates the response
// against it, so ONE undeclared key makes a strict client throw the entire
// answer away. Every local test still passed both times, because none of them
// validated the real object against the published schema. This one does.
{
  const { CommentsOutput } = require('../electron/mcp/reviewTools.js');
  const live = via('reviews:shared').shared;

  check('the shared status is reachable', !!live && typeof live === 'object', JSON.stringify(live));

  // Parsed rather than eyeballed: Zod strips what it does not declare, so a
  // key that survives the round trip is a key the schema knows about.
  const parsed = CommentsOutput.safeParse({
    ok: true,
    revision: 1,
    status: 'all',
    scope: 'project',
    total: 0,
    returned: 0,
    truncated: false,
    reviews: [],
    problem: null,
    shared: live,
  });
  check('a get_comments response carrying it validates', parsed.success === true, parsed.success ? '' : JSON.stringify(parsed.error?.issues));

  const dropped = parsed.success ? Object.keys(live).filter((k) => !(k in parsed.data.shared)) : Object.keys(live);
  check(
    'EVERY key sharedStatus() sends is declared in the MCP schema',
    dropped.length === 0,
    dropped.length ? `undeclared, so a strict client rejects the whole response: ${dropped.join(', ')}` : ''
  );

  // The three that were missing, named, so a future removal is deliberate
  // rather than accidental.
  for (const key of ['mode', 'secure', 'newShareRelay']) {
    check(`  including \`${key}\``, parsed.success && key in parsed.data.shared);
  }
}

// Focus needs a renderer to answer; with none attached it must refuse rather
// than hang or throw.
(async () => {
  const orphaned = await reviews.focus({ threadId: 'rt_nope' });
  check('focusing an unknown review is a named refusal', orphaned.ok === false && orphaned.code === 'no_thread', JSON.stringify(orphaned));

  reviews.closeProject();
  check('closing the project closes the ledger', via('reviews:list', {}).ok === false);

  Module._load = realLoad;
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nreview-service: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`review-service: ${checked} passed  [the module nothing could load]`);
})();
