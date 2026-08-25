// The review ledger.
//
//   node test/review-store.js
//
// A visual review is the one piece of Stacki state that is supposed to outlive
// everything — the page, the branch, the app, the element it was written
// about. That makes its failures the quiet kind: a comment that silently
// stopped being saved, a status that went back to open after a restart, a file
// that a crash left half written. None of those announce themselves, and all
// of them cost somebody work they had already done.
//
// So three things are checked here, hard:
//
//   The ledger. Every transition, and the fact that the ones that are NOT in
//   the model (todo, blocked, approved) cannot be reached by passing a string.
//
//   The file. Written atomically, read back exactly, and — the two that matter
//   most — a corrupt file is moved aside rather than deleted, and a file from a
//   newer Stacki is never overwritten by an older one.
//
//   The anchor. Built from the same payload the MCP snapshot is built from, so
//   a review and `get_context` can never disagree about what "this" is.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const {
  createReviewStore,
  selectThreads,
  summarize,
  detail: detailOf,
  scopeKey,
  fileFor,
  loadFile,
  reviveThread,
  VERSION,
  MAX_BODY,
  MAX_REASON,
  MAX_REF,
  MAX_REFS,
  MAX_MESSAGES,
  ACTIONS,
  COLORS,
  MAX_DETAIL_MESSAGES,
} = require('../electron/review/store.js');
const { anchorFrom, leafKey, fileOfKey, sameTarget } = require('../electron/review/anchor.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-review-'));
const ROOT = path.join(os.tmpdir(), 'stacki-review-project');

// A published renderer payload — the real shape, from src/mcpContext.js.
const payload = (over = {}) => ({
  project: { root: ROOT, branch: 'feat/new-hero' },
  page: { route: '/', file: path.join(ROOT, 'src/pages/index.astro') },
  view: { device: 'phone', viewportWidth: 375, viewportHeight: 800 },
  preview: { status: 'on' },
  selection: {
    present: true,
    nodeKind: 'element',
    tag: 'span',
    occurrence: 1,
    occurrenceCount: 4,
    keys: ['src/pages/index.astro#0.3', 'src/components/HeroSection.astro#0.1.2'],
    componentChain: ['index', 'HeroSection'],
    breadcrumbs: ['index', 'section', 'span'],
    text: 'Learn more',
    props: { class: 'pill' },
    classes: ['pill'],
    hidden: false,
    inert: false,
    rect: { x: 10, y: 20, w: 100, h: 40 },
    ...(over.selection || {}),
  },
  ...(({ selection, ...rest }) => rest)(over),
});

// Fixed time and predictable ids, so every assertion below is about behaviour.
let clock = 1000;
const now = () => clock;
let seq = 0;
const newId = () => `id${++seq}`;

const freshStore = (file, opts = {}) =>
  createReviewStore({ file, projectPath: ROOT, now, newId, ...opts });

const anchorOf = (over) => {
  const built = anchorFrom(payload(over));
  return built.ok ? built : null;
};

// ── The anchor ──────────────────────────────────────────────────────────────

{
  const built = anchorFrom(payload(), { pin: { xRatio: 0.25, yRatio: 0.75 } });
  check('a live selection produces an anchor', built.ok);
  check('the anchor keeps the selection keys, not lines', JSON.stringify(built.anchor.keys) === JSON.stringify(['src/pages/index.astro#0.3', 'src/components/HeroSection.astro#0.1.2']));
  check('no line number is stored on the anchor', !JSON.stringify(built.anchor).includes('startLine'));
  check('the page file is project-relative', built.anchor.page.file === 'src/pages/index.astro', built.anchor.page.file);
  check('the breakpoint is kept', built.anchor.breakpoint.device === 'phone' && built.anchor.breakpoint.viewportWidth === 375);
  check('the rendered copy is kept', built.anchor.occurrence === 1 && built.anchor.occurrenceCount === 4);
  check('the pin is normalized to the element box', built.anchor.pin.xRatio === 0.25 && built.anchor.pin.yRatio === 0.75);
  check('no pin means the middle of the box', anchorFrom(payload()).anchor.pin.xRatio === 0.5);
  check('a pin outside the box is clamped to it', anchorFrom(payload(), { pin: { xRatio: 4, yRatio: -2 } }).anchor.pin.xRatio === 1 && anchorFrom(payload(), { pin: { xRatio: 4, yRatio: -2 } }).anchor.pin.yRatio === 0);

  const c = built.creationContext;
  check('the creation snapshot keeps the component chain', (c.componentChain || []).join('>') === 'index>HeroSection');
  check('the creation snapshot keeps the breadcrumbs', (c.breadcrumbs || []).join('>') === 'index>section>span');
  check('the creation snapshot keeps the visible text', c.text === 'Learn more');
  check('the creation snapshot keeps the rendered box', c.rect && c.rect.width === 100);
  check('the creation snapshot records the branch', c.branch === 'feat/new-hero', c.branch);
  check('the creation snapshot is not a computed style dump', !('computedStyles' in c) && !('essentialComputedStyles' in c));

  // An empty app is a refusal with a name, not an error and not a floating
  // review anchored to nothing.
  check('no project refuses', anchorFrom({ project: { root: null } }).reason === 'no_project');
  check('no page refuses', anchorFrom({ project: { root: ROOT }, page: {} }).reason === 'no_page');
  check('no selection refuses', anchorFrom(payload({ selection: { present: false } })).reason === 'no_selection');
  check(
    'a selection the app cannot name in source refuses',
    anchorFrom(payload({ selection: { keys: [] } })).reason === 'no_selection'
  );
  check(
    'a key with no index path is not a key',
    anchorFrom(payload({ selection: { keys: ['src/pages/index.astro'] } })).reason === 'no_selection'
  );

  check('the leaf key is the node itself', leafKey(built.anchor.keys) === 'src/components/HeroSection.astro#0.1.2');
  check('the file of a key carries no lines', fileOfKey(leafKey(built.anchor.keys)) === 'src/components/HeroSection.astro');
  check('two anchors on the same node are the same target', sameTarget(built.anchor, anchorOf().anchor));
  check(
    'a different node is a different target',
    !sameTarget(built.anchor, anchorOf({ selection: { keys: ['src/components/HeroSection.astro#0.1.3'] } }).anchor)
  );
  // Same source node, different rendered copy: still the same target. Source
  // identity is shared by every copy of a repeated node, and pretending
  // otherwise is the mistake this whole model avoids.
  check(
    'another copy of a repeated node is the same target',
    sameTarget(built.anchor, anchorOf({ selection: { occurrence: 3 } }).anchor)
  );
}

// ── The ledger ──────────────────────────────────────────────────────────────

{
  const file = path.join(home, 'ledger', 'a.json');
  const store = freshStore(file);
  const built = anchorFrom(payload());

  check('a new ledger is empty and writable', store.size === 0 && store.writable && store.revision === 0);
  check('an empty ledger has nothing to report', store.problem === null);

  const created = store.apply({
    action: 'create',
    message: '  The pill is too tight on mobile.  ',
    anchor: built.anchor,
    creationContext: built.creationContext,
  });
  check('create makes a thread', created.ok);
  const id = created.thread.id;
  check('a thread gets an id', typeof id === 'string' && id.startsWith('rt_'), id);
  check('a message gets an id too', created.thread.messages[0].id.startsWith('rm_'));
  check('the body is trimmed', created.thread.messages[0].body === 'The pill is too tight on mobile.');
  check('a new review is open', created.thread.status === 'open');
  check('and attached — the human just pointed at it', created.thread.anchorState === 'attached');
  check('the first message is the human', created.thread.messages[0].authorType === 'human');
  check('timestamps are stamped', created.thread.createdAt === 1000 && created.thread.updatedAt === 1000);
  check('creating bumps the revision', store.revision === 1, String(store.revision));

  // Ids are unique across a store that has been going a while.
  {
    const many = new Set();
    const scratch = createReviewStore({ file: path.join(home, 'ids.json'), projectPath: ROOT, now });
    for (let i = 0; i < 200; i++) {
      many.add(scratch.apply({ action: 'create', message: `note ${i}`, anchor: built.anchor }).thread.id);
    }
    check('two hundred reviews get two hundred distinct ids', many.size === 200, String(many.size));
    check('real ids look like uuids', [...many][0].length > 20);
  }

  clock = 2000;
  const replied = store.apply({ action: 'reply', threadId: id, message: 'Which spacing token?', authorType: 'agent' });
  check('reply adds a message', replied.ok && replied.thread.messages.length === 2);
  check('an agent reply is marked as one', replied.thread.messages[1].authorType === 'agent');
  check('a reply does not change the status', replied.thread.status === 'open');
  check('a reply moves updatedAt', replied.thread.updatedAt === 2000 && replied.thread.createdAt === 1000);

  clock = 3000;
  const deferred = store.apply({
    action: 'defer',
    threadId: id,
    reason: 'Needs a decision between the two pill sizes.',
    externalRef: 'https://github.com/example/repo/issues/418',
    message: 'Raised as an issue.',
    authorType: 'agent',
  });
  check('defer sets the status', deferred.ok && deferred.thread.status === 'deferred');
  check('the reason is kept', deferred.thread.deferredReason === 'Needs a decision between the two pill sizes.');
  check('the external reference is kept as text', deferred.thread.externalRefs[0].endsWith('/418'));
  check('a deferral can carry a message too', deferred.thread.messages.length === 3);
  check('the same reference is not stored twice', store.apply({ action: 'defer', threadId: id, externalRef: 'https://github.com/example/repo/issues/418' }).thread.externalRefs.length === 1);

  clock = 4000;
  const reopened = store.apply({ action: 'reopen', threadId: id, message: 'We decided: use the small pill.' });
  check('reopen goes back to open', reopened.ok && reopened.thread.status === 'open');
  check('reopening clears the reason it was put off', reopened.thread.deferredReason === null);
  check('but the history of it stays', reopened.thread.messages.some((m) => m.body === 'Raised as an issue.'));
  check('and so does the reference', reopened.thread.externalRefs.length === 1);

  clock = 5000;
  const resolved = store.apply({ action: 'resolve', threadId: id, message: 'Implemented and visually verified.', authorType: 'agent' });
  check('resolve sets the status', resolved.ok && resolved.thread.status === 'resolved');
  check('resolve can carry the final word', resolved.thread.messages[resolved.thread.messages.length - 1].body === 'Implemented and visually verified.');
  check('a bare resolve is allowed too', store.apply({ action: 'resolve', threadId: id }).ok);

  // The states that are deliberately NOT in the model cannot be reached.
  for (const bogus of ['todo', 'doing', 'in_progress', 'blocked', 'accepted', 'rejected', 'wontfix', 'approved', 'closed', 'delete']) {
    check(`"${bogus}" is not an action`, store.apply({ action: bogus, threadId: id }).code === 'bad_action');
  }
  check('an unknown id is a named refusal', store.apply({ action: 'reply', threadId: 'nope', message: 'x' }).code === 'no_thread');
  check('a reply with nothing in it is refused', store.apply({ action: 'reply', threadId: id, message: '   ' }).code === 'no_message');
  check('a create with nothing in it is refused', store.apply({ action: 'create', message: '', anchor: built.anchor }).code === 'no_message');
  check('a create with nothing to point at is refused', store.apply({ action: 'create', message: 'hi' }).code === 'no_target');

  // Anchor health is not a status.
  check('anchor state and workflow status are independent', (() => {
    const open = store.apply({ action: 'create', message: 'still here', anchor: built.anchor }).thread;
    store.syncAnchors([{ id: open.id, anchorState: 'orphaned' }]);
    const after = store.get(open.id);
    return after.status === 'open' && after.anchorState === 'orphaned';
  })());
  check('syncing the same state costs nothing', (() => {
    const before = store.revision;
    store.syncAnchors(store.all().map((t) => ({ id: t.id, anchorState: t.anchorState })));
    return store.revision === before;
  })());
  check('an orphan going back attached is a change', (() => {
    const orphan = store.all().find((t) => t.anchorState === 'orphaned');
    const before = store.revision;
    store.syncAnchors([{ id: orphan.id, anchorState: 'attached' }]);
    return store.revision === before + 1 && store.get(orphan.id).anchorState === 'attached';
  })());
  // Re-anchoring: a node that moved is still the same node, and the renderer
  // says where it went. Without this the anchor pays for the search again on
  // every read, and reports the file:line of whatever now sits where it used
  // to be.
  check('a moved node writes its new position back', (() => {
    const t = store.all()[0];
    const before = store.revision;
    const moved = ['src/pages/index.astro#0.4', 'src/components/HeroSection.astro#0.1.3'];
    store.syncAnchors([{ id: t.id, anchorState: t.anchorState, keys: moved }]);
    return store.get(t.id).anchor.keys.join() === moved.join() && store.revision === before + 1;
  })());
  check('and nothing else about the review moves with it', (() => {
    const t = store.all()[0];
    const was = store.get(t.id).updatedAt;
    store.syncAnchors([{ id: t.id, keys: ['a#9'] }]);
    const after = store.get(t.id);
    return after.updatedAt === was && after.anchor.keys.join() === 'a#9' && after.anchor.fingerprint !== undefined;
  })());
  check('re-anchoring to the same place costs nothing', (() => {
    const t = store.all()[0];
    const before = store.revision;
    store.syncAnchors([{ id: t.id, keys: store.get(t.id).anchor.keys }]);
    return store.revision === before;
  })());
  check('an empty key list is not a re-anchor', (() => {
    const t = store.all()[0];
    const keys = store.get(t.id).anchor.keys;
    store.syncAnchors([{ id: t.id, keys: [] }]);
    return store.get(t.id).anchor.keys.join() === keys.join();
  })());
  check('a bogus anchor state is ignored', (() => {
    const t = store.all()[0];
    store.syncAnchors([{ id: t.id, anchorState: 'missing' }]);
    return store.get(t.id).anchorState === 'attached';
  })());
  check('an anchor going orphaned does not look like somebody editing it', (() => {
    const t = store.all()[0];
    const before = store.get(t.id).updatedAt;
    store.syncAnchors([{ id: t.id, anchorState: 'orphaned' }]);
    return store.get(t.id).updatedAt === before;
  })());

  // Colour is the person's own filing, and state is the marker's shape. So a
  // colour is never a status and can never be set by an agent naming an action.
  check('a review starts in the default colour', store.all()[0].color === 'blue', store.all()[0].color);
  check('a colour can be chosen at creation', store.apply({ action: 'create', message: 'violet one', anchor: built.anchor, color: 'violet' }).thread.color === 'violet');
  check('a colour nobody defined falls back rather than sticking', store.apply({ action: 'create', message: 'x', anchor: built.anchor, color: 'chartreuse' }).thread.color === 'blue');
  check('a review can be recoloured', (() => {
    const t = store.all()[0];
    return store.setColor(t.id, 'teal').ok && store.get(t.id).color === 'teal';
  })());
  check('by its number too', (() => {
    const t = store.all()[0];
    return store.setColor(`#${t.number}`, 'rose').ok && store.get(t.id).color === 'rose';
  })());
  check('a colour outside the palette is refused', store.setColor(store.all()[0].id, '#ff0000').code === 'bad_color');
  check('recolouring is not an edit — nothing was said', (() => {
    const t = store.all()[0];
    const was = store.get(t.id).updatedAt;
    store.setColor(t.id, 'green');
    return store.get(t.id).updatedAt === was;
  })());
  check('and it is not an action an agent can name', !ACTIONS.includes('color') && !ACTIONS.includes('recolor'));
  check('setting the same colour twice costs nothing', (() => {
    const t = store.all()[0];
    const before = store.revision;
    store.setColor(t.id, store.get(t.id).color);
    return store.revision === before;
  })());
  check('the palette is small enough to choose from', COLORS.length >= 4 && COLORS.length <= 8, String(COLORS.length));

  // Deleting is a person's decision, and is not an action an agent can name.
  const target = store.apply({ action: 'create', message: 'delete me', anchor: built.anchor }).thread;
  check('a human can delete a review', store.remove(target.id).ok && !store.get(target.id));
  check('deleting something gone is a named refusal', store.remove(target.id).code === 'no_thread');
  check('read() cannot be mutated into the store', (() => {
    const copy = store.get(id);
    copy.status = 'open';
    copy.messages.push({ body: 'injected' });
    return store.get(id).status === 'resolved' && store.get(id).messages.every((m) => m.body !== 'injected');
  })());
}

// ── Bounds ──────────────────────────────────────────────────────────────────

{
  const store = freshStore(path.join(home, 'bounds.json'));
  const { anchor, creationContext } = anchorFrom(payload());
  const long = 'x'.repeat(MAX_BODY * 3);
  const t = store.apply({ action: 'create', message: long, anchor, creationContext }).thread;
  check('a huge comment body is cut to the limit', t.messages[0].body.length === MAX_BODY, String(t.messages[0].body.length));
  const d = store.apply({ action: 'defer', threadId: t.id, reason: 'y'.repeat(MAX_REASON * 3), externalRef: 'z'.repeat(MAX_REF * 3) }).thread;
  check('a huge reason is cut to the limit', d.deferredReason.length === MAX_REASON);
  check('a huge reference is cut to the limit', d.externalRefs[0].length === MAX_REF);
  for (let i = 0; i < MAX_REFS + 5; i++) store.apply({ action: 'defer', threadId: t.id, externalRef: `ref-${i}` });
  check('references stop at the cap', store.get(t.id).externalRefs.length === MAX_REFS, String(store.get(t.id).externalRefs.length));

  const chatty = store.apply({ action: 'create', message: 'start', anchor }).thread;
  for (let i = 0; i < MAX_MESSAGES + 10; i++) store.apply({ action: 'reply', threadId: chatty.id, message: `reply ${i}` });
  check('a thread stops accepting messages at the cap', store.get(chatty.id).messages.length === MAX_MESSAGES, String(store.get(chatty.id).messages.length));
  check(
    'and says so rather than silently dropping one',
    store.apply({ action: 'reply', threadId: chatty.id, message: 'one more' }).code === 'too_many_messages'
  );

  const excerpt = summarize(store.get(t.id));
  check('a summary excerpt is short', excerpt.message.length <= 200, String(excerpt.message.length));
  check('a summary carries no message list at all', !('messages' in excerpt));
  check('a summary says where it is', excerpt.page === '/' && excerpt.source === 'src/components/HeroSection.astro', JSON.stringify(excerpt));
  check('a summary says which copy', excerpt.occurrence === 1 && excerpt.occurrenceCount === 4);
  check('a summary says the breakpoint', excerpt.breakpoint === 'phone');
  check('one pathological review cannot flood a response', JSON.stringify(excerpt).length < 900, String(JSON.stringify(excerpt).length));

  // A full read has to stay a thing somebody can put in a context window. A
  // thread may hold MAX_MESSAGES of MAX_BODY each; returning all of them is
  // most of a megabyte for one review.
  {
    const long = store.apply({ action: 'create', message: 'start', anchor, creationContext }).thread;
    for (let i = 0; i < MAX_MESSAGES; i++) store.apply({ action: 'reply', threadId: long.id, message: 'y'.repeat(MAX_BODY) });
    const read = detailOf(store.get(long.id), null);
    check('a very long thread comes back capped', read.messages.length === MAX_DETAIL_MESSAGES, String(read.messages.length));
    check('and says how many it left out', read.messagesOmitted === MAX_MESSAGES - MAX_DETAIL_MESSAGES, String(read.messagesOmitted));
    check('the newest are the ones kept', read.messages[read.messages.length - 1].body.length === MAX_BODY);
    check('the original is still readable in the summary', read.message === 'start');
    check('so one review cannot be megabytes', JSON.stringify(read).length < 300_000, `${JSON.stringify(read).length} bytes`);
    const short = detailOf(store.get(t.id), null);
    check('a short thread reports nothing omitted', short.messagesOmitted === 0);
  }

  const full = detailOf(store.get(t.id), (keys) => keys.map((k) => ({ file: k.split('#')[0], startLine: 3, endLine: 7 })));
  check('a full read carries the messages', Array.isArray(full.messages) && full.messages.length > 0);
  check('a full read resolves the anchor to current lines', full.anchor.sourceTrail[0].startLine === 3);
  check('a full read carries the creation snapshot', full.creationContext.text === 'Learn more');
  check('a full read carries the deferral', full.deferredReason.length === MAX_REASON);
}

// ── Filtering ───────────────────────────────────────────────────────────────

{
  const store = freshStore(path.join(home, 'filter.json'));
  const one = anchorFrom(payload()).anchor;
  const other = anchorFrom(
    payload({
      page: { route: '/about', file: path.join(ROOT, 'src/pages/about.astro') },
      selection: { keys: ['src/pages/about.astro#0.0'] },
    })
  ).anchor;
  clock = 10;
  const a = store.apply({ action: 'create', message: 'open one', anchor: one }).thread;
  clock = 20;
  const b = store.apply({ action: 'create', message: 'deferred one', anchor: one }).thread;
  clock = 30;
  const c = store.apply({ action: 'create', message: 'resolved one', anchor: other }).thread;
  clock = 40;
  store.apply({ action: 'defer', threadId: b.id, reason: 'later' });
  clock = 50;
  store.apply({ action: 'resolve', threadId: c.id });

  const ids = (opts) => selectThreads(store.all(), opts).threads.map((t) => t.id);
  check('open is the default filter', ids({}).join() === a.id);
  check('deferred filters to deferred', ids({ status: 'deferred' }).join() === b.id);
  check('resolved filters to resolved', ids({ status: 'resolved' }).join() === c.id);
  check('all is all three', ids({ status: 'all' }).length === 3);
  check('all is newest-change first', ids({ status: 'all' })[0] === c.id, ids({ status: 'all' }).join());
  check('project scope is every page', ids({ status: 'all', scope: 'project' }).length === 3);
  check(
    'page scope is one page',
    ids({ status: 'all', scope: 'page', page: { route: '/about', file: 'src/pages/about.astro' } }).join() === c.id
  );
  check(
    'page scope matches on the file when the route is dynamic',
    ids({ status: 'all', scope: 'page', page: { route: null, file: 'src/pages/about.astro' } }).join() === c.id
  );
  check(
    'selection scope is the selected node',
    ids({ status: 'all', scope: 'selection', keys: ['src/components/HeroSection.astro#0.1.2'] }).length === 2
  );
  check(
    'selection scope with nothing selected is nothing',
    ids({ status: 'all', scope: 'selection', keys: null }).length === 0
  );
  const capped = selectThreads(store.all(), { status: 'all', limit: 2 });
  check('a limit caps the list', capped.threads.length === 2);
  check('and says the list was cut', capped.truncated === true && capped.total === 3);
  check('a silly limit is clamped, not obeyed', selectThreads(store.all(), { status: 'all', limit: 1e6 }).threads.length === 3);
}

// ── The file ────────────────────────────────────────────────────────────────

(async () => {
  // Persistence across a restart.
  {
    const file = path.join(home, 'persist', 'p.json');
    const store = freshStore(file);
    const { anchor, creationContext } = anchorFrom(payload());
    clock = 7000;
    const t = store.apply({ action: 'create', message: 'survives a restart', anchor, creationContext }).thread;
    store.apply({ action: 'defer', threadId: t.id, reason: 'needs a decision', externalRef: 'https://example.test/1' });
    await store.flush();
    check('the ledger is written where it was told to go', fs.existsSync(file));
    check('the file is not in the project', !file.startsWith(ROOT));

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('the file says which version it is', saved.version === VERSION);
    check('the file is a list of threads', Array.isArray(saved.threads) && saved.threads.length === 1);
    check('no temporary file is left behind', fs.readdirSync(path.dirname(file)).every((f) => !f.includes('tmp')), fs.readdirSync(path.dirname(file)).join());

    const reopened = freshStore(file);
    check('a new store reads the same reviews', reopened.size === 1);
    const back = reopened.all()[0];
    check('the status survived', back.status === 'deferred');
    check('the reason survived', back.deferredReason === 'needs a decision');
    check('the reference survived', back.externalRefs[0] === 'https://example.test/1');
    check('the anchor survived', leafKey(back.anchor.keys) === 'src/components/HeroSection.astro#0.1.2');
    check('the creation snapshot survived', back.creationContext.text === 'Learn more');
    check('the branch it was written on survived', back.creationContext.branch === 'feat/new-hero');
    check('the timestamps survived', back.createdAt === 7000);
    check('a reopened store starts its revision again', reopened.revision === 0);
  }

  // ── Numbers are names, not positions ──────────────────────────────────────
  //
  // "#3" is what a person reads off a pin and says to an agent, and what that
  // agent then acts on possibly after a restart. If it ever came to mean a
  // different review, the agent would confidently do the wrong work. So a
  // number is assigned once and is never an index, never a position in a
  // filtered list, and never handed out twice.
  {
    const file = path.join(home, 'numbers.json');
    let store = freshStore(file);
    const anchor = anchorFrom(payload()).anchor;
    const made = [1, 2, 3, 4].map((n) => store.apply({ action: 'create', message: `m${n}`, anchor }).thread);
    check('numbers are handed out in order', made.map((t) => t.number).join() === '1,2,3,4', made.map((t) => t.number).join());

    // Deleting one must not shuffle the rest.
    store.remove(made[1].id);
    check('deleting #2 leaves #3 as #3', store.get(made[2].id).number === 3);
    check('and #4 as #4', store.get(made[3].id).number === 4);
    check('and #2 resolves to nothing at all', store.get('#2') === null);

    // Filtering and sorting are views. They cannot rename anything.
    store.apply({ action: 'resolve', threadId: '#1' });
    const byStatus = selectThreads(store.all(), { status: 'all' }).threads;
    check('a sorted list keeps every number', byStatus.map((t) => t.number).sort((a, b) => a - b).join() === '1,3,4');
    // Position and number are independent: the first row of the open list is
    // #3, because #1 was resolved out of it and #2 deleted.
    check('a list position is not a number', selectThreads(store.all(), { status: 'open' }).threads[0].number === 3, String(selectThreads(store.all(), { status: 'open' }).threads[0].number));
    check('a filtered list renames nothing', selectThreads(store.all(), { status: 'open' }).threads.every((t) => t.number === store.get(t.id).number));

    // The one that only shows up across a restart: the high-water mark has to
    // survive, or a deleted number is handed to a new review and every agent
    // that was told "#4" is now pointed at something else.
    const beforeRestart = store.get(made[3].id).id;
    store.remove(made[3].id);
    await store.flush();
    store = freshStore(file);
    check('a restart does not renumber the survivors', store.get('#1').id === made[0].id && store.get('#3').id === made[2].id);
    const afterRestart = store.apply({ action: 'create', message: 'new one', anchor }).thread;
    check('and a deleted number is never handed out again', afterRestart.number === 5, `got #${afterRestart.number}`);
    check('so the deleted one still resolves to nothing', store.get('#4') === null && store.get(beforeRestart) === null);
    await store.flush();
    check('the high-water mark is written down, not derived', JSON.parse(fs.readFileSync(file, 'utf8')).nextNumber === 6, String(JSON.parse(fs.readFileSync(file, 'utf8')).nextNumber));

    // Even after every review is gone, the counter does not rewind.
    for (const t of store.all()) store.remove(t.id);
    await store.flush();
    store = freshStore(file);
    check('an emptied ledger still remembers how far it got', store.apply({ action: 'create', message: 'after the purge', anchor }).thread.number === 6);

    // A file that somehow names two reviews the same thing: "#n" has to mean
    // exactly one review, so the later one is renamed rather than left
    // ambiguous.
    const dupe = path.join(home, 'dupes.json');
    fs.writeFileSync(
      dupe,
      JSON.stringify({
        version: 1,
        nextNumber: 3,
        threads: [
          { id: 'rt_a', number: 2, anchor: { keys: ['a#0'] }, messages: [{ id: 'm1', body: 'older', createdAt: 10 }], createdAt: 10, updatedAt: 10 },
          { id: 'rt_b', number: 2, anchor: { keys: ['a#1'] }, messages: [{ id: 'm2', body: 'newer', createdAt: 20 }], createdAt: 20, updatedAt: 20 },
        ],
      }),
      'utf8'
    );
    const fixed = freshStore(dupe);
    check('a duplicated number names exactly one review', fixed.get('#2').messages[0].body === 'older');
    check('and the other is renamed rather than left ambiguous', fixed.all().find((t) => t.id === 'rt_b').number === 3);
    check('every number in a ledger is distinct', new Set(fixed.all().map((t) => t.number)).size === fixed.size);
  }

  // Two projects never see each other's reviews.
  {
    const other = path.join(os.tmpdir(), 'stacki-review-other-project');
    check('two projects get two different files', fileFor(home, ROOT) !== fileFor(home, other));
    check('the same project gets the same file every time', fileFor(home, ROOT) === fileFor(home, ROOT));
    check('a scope key is stable and short', scopeKey(ROOT).length === 16 && scopeKey(ROOT) === scopeKey(ROOT + '/'));
    const a = createReviewStore({ file: fileFor(home, ROOT), projectPath: ROOT, now, newId });
    const b = createReviewStore({ file: fileFor(home, other), projectPath: other, now, newId });
    a.apply({ action: 'create', message: 'belongs to A', anchor: anchorFrom(payload()).anchor });
    await a.flush();
    await b.flush();
    check("one project's review does not appear in another", b.size === 0);
    check('and the first one still has it', createReviewStore({ file: fileFor(home, ROOT), projectPath: ROOT, now }).size === 1);
  }

  // ── The ledger cannot be talked out of userData ───────────────────────────
  //
  // The only variable part of the path is a hash of the project's real path,
  // so nothing a project (or a renderer, or an agent) can say about itself
  // becomes part of a filename.
  {
    const nasty = [
      '../../../../etc/passwd',
      '/tmp/../../../root/.ssh',
      'C:\\Windows\\System32',
      'a\u0000b',
      '~/Library/Application Support/Stacki/mcp-token.json',
      '.'.repeat(300),
    ];
    for (const bad of nasty) {
      const where = fileFor(home, bad);
      check(`"${bad.slice(0, 24)}" stays inside the reviews folder`, path.dirname(where) === path.join(home, 'reviews'), where);
      check(`"${bad.slice(0, 24)}" produces a hash, not a name`, /^[0-9a-f]{16}\.json$/.test(path.basename(where)), path.basename(where));
    }
    check('two hostile paths still get two different files', fileFor(home, nasty[0]) !== fileFor(home, nasty[1]));
    check('and the same project the same file every time', fileFor(home, ROOT) === fileFor(home, ROOT));
  }

  // Branch: recorded on the review, never used to hide it. A review written on
  // one branch is still YOUR feedback on another — what must not happen is it
  // silently pointing at unrelated code, and that is the anchor's job.
  {
    const file = path.join(home, 'branch.json');
    const store = freshStore(file);
    const onFeature = anchorFrom(payload()).anchor;
    const t = store.apply({
      action: 'create',
      message: 'hero copy',
      anchor: onFeature,
      creationContext: anchorFrom(payload()).creationContext,
    }).thread;
    check('the branch is on the review', t.creationContext.branch === 'feat/new-hero');
    check('but the review is not filed under it', !fileFor(home, ROOT).includes('feat'));
    // On main the markup is gone, so the renderer reports it orphaned. The
    // review is still readable, still says which branch it came from, and
    // points at nothing rather than at the wrong thing.
    store.syncAnchors([{ id: t.id, anchorState: 'orphaned' }]);
    const after = store.get(t.id);
    check('an anchor that no longer corresponds is orphaned, not hidden', after.anchorState === 'orphaned' && after.status === 'open');
    check('and it can still be read in full', detailOf(after, () => null).creationContext.text === 'Learn more');
  }

  // Corrupt.
  {
    const file = path.join(home, 'corrupt.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "version": 1, "threads": [ {{{ not json', 'utf8');
    clock = 99;
    const store = freshStore(file);
    check('malformed JSON does not throw', store.size === 0);
    check('and it is reported rather than swallowed', store.problem?.kind === 'corrupt', JSON.stringify(store.problem));
    check('the corrupt file is moved aside, not deleted', !!store.problem.movedTo && fs.existsSync(store.problem.movedTo));
    check('the moved file still holds the original bytes', fs.readFileSync(store.problem.movedTo, 'utf8').includes('not json'));
    check('and the store is usable afterwards', store.apply({ action: 'create', message: 'fresh start', anchor: anchorFrom(payload()).anchor }).ok);
    await store.flush();
    check('which writes a valid file over the empty slot', JSON.parse(fs.readFileSync(file, 'utf8')).threads.length === 1);
  }

  // Shapes that parse but are not a review file.
  {
    const cases = [
      ['a bare array', '[]'],
      ['a string', '"hello"'],
      ['no version', '{"threads":[]}'],
      ['a nonsense version', '{"version":"one","threads":[]}'],
      ['threads that are not a list', '{"version":1,"threads":{}}'],
    ];
    for (const [what, text] of cases) {
      const file = path.join(home, `shape-${what.replace(/\W+/g, '-')}.json`);
      fs.writeFileSync(file, text, 'utf8');
      const store = freshStore(file);
      check(`${what} is treated as corrupt`, store.problem?.kind === 'corrupt' && store.size === 0, JSON.stringify(store.problem));
      check(`${what} is moved aside`, !!store.problem.movedTo);
    }
  }

  // A file from a newer Stacki. The one case where doing nothing is the only
  // safe thing: an old app rewriting it in the old format destroys real data.
  {
    const file = path.join(home, 'newer.json');
    const original = JSON.stringify({ version: VERSION + 5, threads: [], somethingNew: true });
    fs.writeFileSync(file, original, 'utf8');
    const store = freshStore(file);
    check('a newer file is recognised', store.problem?.kind === 'newer', JSON.stringify(store.problem));
    check('it is not moved aside', !store.problem.movedTo && fs.readFileSync(file, 'utf8') === original);
    check('the store refuses to write', store.writable === false);
    const refused = store.apply({ action: 'create', message: 'x', anchor: anchorFrom(payload()).anchor });
    check('and says why, in words', refused.code === 'read_only' && /newer version/.test(refused.message), refused.message);
    check('deleting is refused too', store.remove('anything').code === 'read_only');
    await store.flush();
    check('nothing was written over it', fs.readFileSync(file, 'utf8') === original);
  }

  // Threads that are individually unusable are dropped; the rest are somebody's
  // actual review and are kept.
  {
    const file = path.join(home, 'partial.json');
    const good = { id: 'rt_1', status: 'open', anchor: { keys: ['a#0'] }, messages: [{ id: 'rm_1', body: 'keep me', createdAt: 5 }], createdAt: 5, updatedAt: 5 };
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        threads: [good, null, {}, { id: 'rt_2', anchor: { keys: [] }, messages: [{ body: 'x' }] }, { id: 'rt_3', anchor: { keys: ['a#0'] }, messages: [] }],
      }),
      'utf8'
    );
    const store = freshStore(file);
    check('the readable threads survive', store.size === 1 && store.all()[0].messages[0].body === 'keep me');
    check('and the damage is reported', store.problem?.kind === 'partial', JSON.stringify(store.problem));
    check('a status nobody recognises falls back to open', reviveThread({ ...good, status: 'approved' }).status === 'open');
    check('an anchor state nobody recognises falls back to attached', reviveThread({ ...good, anchorState: 'lost' }).anchorState === 'attached');
    check('an author nobody recognises falls back to human', reviveThread({ ...good, messages: [{ body: 'x', authorType: 'robot' }] }).messages[0].authorType === 'human');
  }

  // The write itself: previous contents survive a failure, and a burst of
  // mutations collapses into one file rather than one file per keystroke.
  {
    const file = path.join(home, 'atomic.json');
    const store = freshStore(file);
    const anchor = anchorFrom(payload()).anchor;
    store.apply({ action: 'create', message: 'first', anchor });
    await store.flush();
    const first = fs.readFileSync(file, 'utf8');

    for (let i = 0; i < 20; i++) store.apply({ action: 'create', message: `burst ${i}`, anchor });
    // Before the writes land, the file on disk is still the whole previous
    // version — never a truncated one.
    check('the file is never half written', JSON.parse(fs.readFileSync(file, 'utf8')).threads.length >= 1);
    await store.flush();
    check('a burst ends up on disk in full', JSON.parse(fs.readFileSync(file, 'utf8')).threads.length === 21);
    check('and left no temporary files', fs.readdirSync(home).every((f) => !f.endsWith('.tmp')));
    check('the first write was real, not a coincidence', first.includes('first'));

    // Quit: whatever was scheduled has to be on disk before the process goes.
    const q = freshStore(path.join(home, 'quit.json'));
    q.apply({ action: 'create', message: 'written at quit', anchor });
    q.flushSync();
    check('flushSync writes without awaiting anything', JSON.parse(fs.readFileSync(path.join(home, 'quit.json'), 'utf8')).threads.length === 1);
  }

  // Two writers, which is the ordinary case: the panel and an agent.
  {
    const file = path.join(home, 'concurrent.json');
    const store = freshStore(file);
    const anchor = anchorFrom(payload()).anchor;
    const a = store.apply({ action: 'create', message: 'from the panel', anchor }).thread;
    const b = store.apply({ action: 'create', message: 'from the agent', anchor, authorType: 'agent' }).thread;
    // Interleaved, with no awaits between them — the shape of an agent
    // resolving one review while somebody types a reply into another.
    store.apply({ action: 'resolve', threadId: a.id, authorType: 'agent', message: 'done' });
    store.apply({ action: 'reply', threadId: b.id, message: 'and one more thing' });
    await store.flush();
    const back = createReviewStore({ file, projectPath: ROOT, now });
    check('neither write was lost', back.size === 2);
    check('the resolve landed', back.get(a.id).status === 'resolved');
    check('and so did the reply', back.get(b.id).messages.length === 2);
  }

  // ── Two writers, two processes ────────────────────────────────────────────
  //
  // A dev Stacki and a packaged Stacki can both have the same project open.
  // Each holds its own in-memory ledger and each write replaces the whole
  // file, so the second one to write silently erases whatever the first one
  // added — and hands out its numbers again. Losing somebody's review because
  // they had two windows open is not a limitation, it is data loss.
  {
    const file = path.join(home, 'two-writers.json');
    const anchor = anchorFrom(payload()).anchor;
    const A = freshStore(file);
    const B = freshStore(file);
    check('both stores start from the same empty ledger', A.size === 0 && B.size === 0);

    const bThread = B.apply({ action: 'create', message: 'from B', anchor }).thread;
    await B.flush();
    check('B writes first and lands on disk', JSON.parse(fs.readFileSync(file, 'utf8')).threads.length === 1);

    // A's memory predates B's write. Its write must not replace the file.
    const aResult = A.apply({ action: 'create', message: 'from A', anchor });
    await A.flush();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bodies = disk.threads.map((t) => t.messages[0].body);
    check('B\u2019s review is still there', bodies.includes('from B'), JSON.stringify(bodies));
    check('A did not replace the ledger with its stale copy', !bodies.includes('from A'), JSON.stringify(bodies));
    check('A says so rather than failing silently', A.problem?.kind === 'foreign_write', JSON.stringify(A.problem));
    check('and the mutation still succeeded in A\u2019s own memory', aResult.ok);
    check('the file on disk is still valid JSON', typeof disk.version === 'number' && Array.isArray(disk.threads));
    check('numbers were not handed out twice on disk', new Set(disk.threads.map((t) => t.number)).size === disk.threads.length);
    check('reopening sees the winning ledger', freshStore(file).get(bThread.id) !== null);

    // The other order.
    const file2 = path.join(home, 'two-writers-2.json');
    const C = freshStore(file2);
    const D = freshStore(file2);
    C.apply({ action: 'create', message: 'from C', anchor });
    await C.flush();
    D.apply({ action: 'create', message: 'from D', anchor });
    await D.flush();
    const disk2 = JSON.parse(fs.readFileSync(file2, 'utf8')).threads.map((t) => t.messages[0].body);
    check('whoever wrote first keeps the ledger', disk2.join() === 'from C', JSON.stringify(disk2));
    check('and the loser reports the conflict', D.problem?.kind === 'foreign_write', JSON.stringify(D.problem));

    // The race the naive fix does not close: BOTH read, THEN both write.
    // A stat-then-write with no lock lets each observe the same original file
    // and then overwrite the other.
    const file3 = path.join(home, 'two-writers-3.json');
    const E = freshStore(file3);
    const F = freshStore(file3);
    E.apply({ action: 'create', message: 'from E', anchor });
    F.apply({ action: 'create', message: 'from F', anchor });
    // Interleaved with no await between them — the closest a single process
    // gets to two of them arriving at once.
    const both = Promise.all([E.flush(), F.flush()]);
    await both;
    const disk3 = JSON.parse(fs.readFileSync(file3, 'utf8')).threads.map((t) => t.messages[0].body);
    check('an interleaved pair does not lose a review', disk3.length === 1, JSON.stringify(disk3));
    check('and exactly one of them reports the conflict', [E, F].filter((s2) => s2.problem?.kind === 'foreign_write').length === 1, JSON.stringify([E.problem, F.problem]));
    check('nextNumber never went backwards', JSON.parse(fs.readFileSync(file3, 'utf8')).nextNumber >= 2);
    check('no lock was left behind', !fs.existsSync(`${file3}.lock`));
  }

  // loadFile on its own, since the store swallows the shape it returns.
  {
    check('a missing file is not a problem', loadFile(path.join(home, 'nope.json')).problem === null);
    check('a missing file is writable', loadFile(path.join(home, 'nope.json')).writable === true);
    check('a directory where a file should be is unreadable, not corrupt', loadFile(home).problem?.kind === 'unreadable');
    check('and an unreadable file is never written over', loadFile(home).writable === false);
  }

  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* a leftover temp folder is not a test failure */
  }

  if (failures.length) {
    console.error(`\nreview-store: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`review-store: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
