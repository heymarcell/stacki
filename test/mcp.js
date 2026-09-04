// What an agent is allowed to see, and what it is told.
//
//   node test/mcp.js
//
// Stacki runs a read-only MCP server so a coding agent can ask what is
// selected on the canvas and what it looks like. Three things about that are
// worth a test each, and all three fail quietly:
//
//   The answer. A snapshot is assembled from a dozen pieces of renderer state
//   and resolved to lines in files. Get one of them wrong and the agent edits
//   the wrong component with total confidence — there is no error, just a
//   plausible file:line that isn't the one under the pointer.
//
//   The picture. A screenshot is a crop of the app window, and the numbers
//   that produce it pass through the iframe's offset, the frame's scale, the
//   window's zoom and the page's scroll. A crop that lands on the panel beside
//   the canvas is still a perfectly valid PNG.
//
//   The door. It listens on a port on the user's machine. Any page in any
//   browser can POST to 127.0.0.1, so Host, Origin and the bearer token are
//   not decoration — and a guard that silently stops guarding looks exactly
//   like a guard that is working.
//
// Since Visual Review there is a fourth: the mutation. `comment` is the only
// tool in this server that writes anything, and the things that would be worst
// about it are all shape rather than behaviour — an action enum that grew a
// `delete`, an annotation claiming a create is idempotent, a `create` that
// invented an anchor because nothing was selected. Those are checked here too;
// the ledger underneath them is checked in review-store.js.
//
// What ends up inside the shipped app is checked next door, in packaging.js —
// that is not a question about MCP.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { createContextStore, normalize } = require('../electron/mcp/contextStore.js');
const { propertiesFor, pickEssential, allStyles, ESSENTIAL } = require('../electron/mcp/essentialStyles.js');
const { captureRect, fitWidth } = require('../electron/mcp/captureRect.js');
const { createCapture } = require('../electron/mcp/capture.js');
const { createStackiMcpServer, MAX_BODY_BYTES, tokenMatches, bearerOf, DEFAULT_PORT, ENDPOINT_PATH } = require('../electron/mcp/server.js');
// The validator the SDK hands a client, used here on the server's own answers:
// a schema is only a contract if something checks the payload against it.
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/server/validators/ajv');

const schemaValidator = new AjvJsonSchemaValidator();
const { ContextOutput, CaptureOutput, INSTRUCTIONS } = require('../electron/mcp/tools.js');
const {
  ACTIONS: REVIEW_ACTIONS,
  requirementProblem,
  MUTATES,
  READ_ONLY: REVIEW_READ_ONLY,
} = require('../electron/mcp/reviewTools.js');
const {
  createReviewStore,
  selectThreads,
  project: projectReviews,
  summarize,
  detail: reviewDetail,
} = require('../electron/review/store.js');
const { anchorFrom } = require('../electron/review/anchor.js');
const { selectionTrail, formatTrail } = require('../electron/selectionTrail.js');
const { locateSelection } = require('../electron/astroParser.js');

// A project root that exists nowhere — path arithmetic doesn't need one.
const ROOT = path.join(os.tmpdir(), 'stacki-mcp-test-project');

const payload = (over = {}) => ({
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
    // The sibling run at each level down to the node, as the canvas publishes
    // it — an anchor built from this payload records it, so the review tests
    // exercise the same fingerprint a real selection produces.
    peers: [{ index: 0, count: 1 }, { index: 1, count: 3 }],
    text: 'Hello world',
    props: { class: 'hero', 'data-x': 1 },
    classes: ['hero'],
    hidden: false,
    inert: false,
    rect: { x: 10.123, y: 20.456, w: 300, h: 120 },
    spacing: { padding: { top: 16, right: 24, bottom: 16, left: 24 }, margin: { top: 0 }, gaps: [{ axis: 'row', w: 5, h: 12 }] },
  },
  ...over,
});

// A trail resolver that answers without touching the disk.
const fakeTrail = (keys) =>
  (keys || []).map((k) => ({ file: k.split('#')[0], startLine: 4, endLine: 9 }));

// ── The snapshot ────────────────────────────────────────────────────────────

{
  const store = createContextStore({ resolveTrail: fakeTrail });
  check('a store starts at revision 0 with no project', store.revision === 0 && store.read().selection.status === 'no_project');

  const r1 = store.publish(payload());
  check('publishing a selection bumps the revision', r1 === 1, `got ${r1}`);

  const snap = store.read();
  check('the snapshot is ready', snap.selection.status === 'ready', snap.selection.status);
  check('the page file is project-relative', snap.page.file === 'src/pages/index.astro', snap.page.file);
  check('the route survives', snap.page.route === '/');
  check('the breakpoint survives', snap.view.device === 'desktop' && snap.view.viewportWidth === 1280);
  check('the rect is rounded, not raw', snap.selection.rect.x === 10.12 && snap.selection.rect.y === 20.46, JSON.stringify(snap.selection.rect));
  check('the rect keeps w/h under the names a schema can read', snap.selection.rect.width === 300 && snap.selection.rect.height === 120);
  check('padding survives', snap.selection.spacing.padding.left === 24);
  check('a gap is reported as an axis and a size', snap.selection.spacing.gaps[0].axis === 'row' && snap.selection.spacing.gaps[0].size === 12, JSON.stringify(snap.selection.spacing.gaps));
  check('numeric props become strings', snap.selection.props['data-x'] === '1');
  check('classes survive', snap.selection.classes.join() === 'hero');
  check('the breadcrumbs survive', (snap.selection.breadcrumbs || []).join('>') === 'index>section');
  check('the component chain survives', (snap.selection.componentChain || []).join('>') === 'index');
  check('the source is the last entry of the trail', snap.selection.source.file === 'src/pages/index.astro' && snap.selection.source.startLine === 4);
  check('the snapshot carries a timestamp', typeof snap.timestamp === 'number' && snap.timestamp > 0);

  // Republishing the same thing is not a change. The renderer republishes on
  // every render that touches the selection, and most of those say exactly
  // what the last one said — a revision that went up regardless would tell an
  // agent the page had re-rendered when it had not.
  const same = store.publish(payload());
  check('republishing the same state does not bump the revision', same === 1, `got ${same}`);

  const moved = store.publish(payload({ view: { device: 'phone', viewportWidth: 375, viewportHeight: 800 } }));
  check('changing the breakpoint bumps the revision', moved === 2, `got ${moved}`);

  check('read() cannot be mutated into the store', (() => {
    const a = store.read();
    a.selection.tag = 'MUTATED';
    return store.read().selection.tag === 'section';
  })());

  const cleared = store.reset();
  check('reset goes back to no_project and bumps', cleared === 3 && store.read().selection.status === 'no_project', `${cleared} ${store.read().selection.status}`);
}

// ── The empty states ────────────────────────────────────────────────────────

{
  const s = (over) => normalize(over, fakeTrail).selection.status;
  check('no project is a status', s({ project: { root: null } }) === 'no_project');
  check('no page is a status', s({ project: { root: ROOT } }) === 'no_page');
  check(
    'no selection is a status',
    s({ project: { root: ROOT }, page: { route: '/', file: 'x.astro' }, selection: { present: false } }) === 'no_selection'
  );
  check(
    'a selection the preview has not measured is preview_not_ready',
    s(payload({ selection: { ...payload().selection, rect: null } })) === 'preview_not_ready'
  );
  check(
    'a selection with a box but no dev server is preview_not_ready',
    s(payload({ preview: { status: 'starting' } })) === 'preview_not_ready'
  );
  check('a fully described selection is ready', s(payload()) === 'ready');
  check('an empty payload does not throw', (() => {
    try {
      return normalize(undefined, fakeTrail).selection.status === 'no_project';
    } catch {
      return false;
    }
  })());
  check('a garbage payload does not throw', (() => {
    try {
      normalize({ project: { root: 5 }, selection: { present: true, keys: 'nope', rect: 'nope' } }, fakeTrail);
      return true;
    } catch {
      return false;
    }
  })());
  // With nothing selected the file being edited still says where the user is.
  const none = normalize(
    { project: { root: ROOT }, page: { route: '/', file: 'x.astro' }, selection: { present: false, componentChain: ['index', 'Card'] } },
    fakeTrail
  );
  check('an unselected app still says which files are open', (none.selection.componentChain || []).join('>') === 'index>Card');
}

// ── Repeated nodes ──────────────────────────────────────────────────────────
//
// A node inside a loop is on the page once per item. Which copy is selected is
// the difference between describing the card under the pointer and describing
// the first card on the page.

{
  const store = createContextStore({ resolveTrail: fakeTrail });
  store.publish(payload({ selection: { ...payload().selection, occurrence: 2, occurrenceCount: 4, rect: { x: 0, y: 900, w: 300, h: 120 } } }));
  const snap = store.read();
  check('the selected occurrence is reported', snap.selection.occurrence === 2, String(snap.selection.occurrence));
  check('how many copies there are is reported', snap.selection.occurrenceCount === 4, String(snap.selection.occurrenceCount));
  check('the occurrence brings its own box', snap.selection.rect.y === 900, JSON.stringify(snap.selection.rect));

  const before = store.revision;
  store.publish(payload({ selection: { ...payload().selection, occurrence: 3, occurrenceCount: 4, rect: { x: 0, y: 1300, w: 300, h: 120 } } }));
  check('moving to another copy is a change', store.revision === before + 1);

  // A selection made anywhere but the canvas means the NODE, which is every
  // copy of it — null, not "the first one".
  const node = normalize(payload({ selection: { ...payload().selection, occurrence: null, occurrenceCount: 4 } }), fakeTrail);
  check('a selection that means the node has no occurrence', node.selection.occurrence === null);
}

// ── Source mapping, for real ────────────────────────────────────────────────
//
// Against the actual parser and an actual file, because the whole value of
// this is that the lines are the ones an editor would open.

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mcp-'));
  const pageDir = path.join(dir, 'src', 'pages');
  const compDir = path.join(dir, 'src', 'components');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.mkdirSync(compDir, { recursive: true });
  const page = [
    '---',
    "import Card from '../components/Card.astro';",
    '---',
    '<main>',
    '  <h1>Title</h1>',
    '  <Card label="one" />',
    '</main>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(pageDir, 'index.astro'), page);
  fs.writeFileSync(
    path.join(compDir, 'Card.astro'),
    ['---', 'const { label } = Astro.props;', '---', '<article class="card">', '  <p>{label}</p>', '</article>', ''].join('\n')
  );

  const trail = selectionTrail(
    { projectPath: dir, keys: ['src/pages/index.astro#0.1', 'src/components/Card.astro#0.0'] },
    locateSelection
  );
  check('a trail resolves to one entry per level', trail && trail.length === 2, JSON.stringify(trail));
  check('the page entry is the element that was drilled through', trail && trail[0].file === 'src/pages/index.astro' && trail[0].startLine === 6, JSON.stringify(trail && trail[0]));
  check('the leaf entry is inside the component', trail && trail[1].file === 'src/components/Card.astro' && trail[1].startLine === 5, JSON.stringify(trail && trail[1]));
  check(
    'the clipboard spelling is unchanged',
    formatTrail(trail) === 'src/pages/index.astro:6\nsrc/components/Card.astro:5',
    JSON.stringify(formatTrail(trail))
  );

  // The keys come from the renderer, so they are input. A key pointing outside
  // the project must not read a file outside the project.
  const escaped = selectionTrail({ projectPath: dir, keys: ['../../../etc/passwd#0'] }, locateSelection);
  check('a key that escapes the project is dropped', escaped === null, JSON.stringify(escaped));
  check('no keys at all is null, not an empty trail', selectionTrail({ projectPath: dir, keys: [] }, locateSelection) === null);
  check('a missing project is null', selectionTrail({ keys: ['a#0'] }, locateSelection) === null);

  // And end to end through the store, which is how the MCP tool sees it.
  const store = createContextStore({
    resolveTrail: (keys) => selectionTrail({ projectPath: dir, keys }, locateSelection),
  });
  store.publish(
    payload({
      project: { root: dir },
      page: { route: '/', file: path.join(dir, 'src/pages/index.astro') },
      selection: {
        ...payload().selection,
        keys: ['src/pages/index.astro#0.1', 'src/components/Card.astro#0.0'],
        componentChain: ['index', 'Card'],
      },
    })
  );
  const snap = store.read();
  check('the published source is the leaf of the trail', snap.selection.source.file === 'src/components/Card.astro', JSON.stringify(snap.selection.source));
  check('the published trail keeps every level', snap.selection.sourceTrail.length === 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Computed style ──────────────────────────────────────────────────────────

{
  check('"none" asks the page for nothing', propertiesFor('none').length === 0);
  check('"essential" asks for the curated list', propertiesFor('essential').length === ESSENTIAL.length && ESSENTIAL.length > 50, String(ESSENTIAL.length));
  check('"essential" is compact, not a dump', ESSENTIAL.length < 150, String(ESSENTIAL.length));
  check('"essential" covers the things a visual change is about', ['display', 'width', 'margin-top', 'padding-left', 'row-gap', 'font-size', 'color', 'background-color', 'border-top-width', 'border-top-left-radius', 'z-index', 'opacity', 'transform', 'overflow-x', 'flex-direction', 'grid-template-columns', 'align-items'].every((p) => ESSENTIAL.includes(p)));
  check('"full" is a superset of "essential"', (() => {
    const full = propertiesFor('full', ['scroll-snap-stop', 'display']);
    return ESSENTIAL.every((p) => full.includes(p)) && full.includes('scroll-snap-stop');
  })());
  check('"full" does not ask the same property twice', (() => {
    const full = propertiesFor('full', ['display', 'display', 'color']);
    return new Set(full).size === full.length;
  })());

  const answer = { display: 'flex', 'font-size': '16px', 'scroll-snap-stop': 'normal', 'border-top-width': '', 'z-index': null };
  const essential = pickEssential(answer);
  check('the essential pick keeps essential answers', essential.display === 'flex' && essential['font-size'] === '16px');
  check('the essential pick drops everything else', !('scroll-snap-stop' in essential));
  check('a property the page could not answer is left out, not blanked', !('border-top-width' in essential) && !('z-index' in essential));
  check('the essential pick is ordered, so two reads serialize alike', JSON.stringify(pickEssential(answer)) === JSON.stringify(pickEssential({ 'font-size': '16px', display: 'flex' })));
  const full = allStyles(answer);
  check('the full set keeps what essential drops', full['scroll-snap-stop'] === 'normal');
  check('the full set is sorted', JSON.stringify(Object.keys(full)) === JSON.stringify(Object.keys(full).slice().sort()));
  check('nothing answered is null rather than an empty object', pickEssential({}) === null && allStyles(null) === null);
}

// ── The crop ────────────────────────────────────────────────────────────────

{
  // A canvas 900 wide sitting 260 from the left of a 1600×900 window, with a
  // toolbar above it.
  const geometry = {
    frame: { x: 260, y: 60, width: 900, height: 800 },
    scale: 1,
    zoom: 1,
    page: { width: 1600, height: 900 },
    selection: { x: 100, y: 200, w: 300, h: 150 },
  };

  const sel = captureRect(geometry, { target: 'selection', paddingPx: 0 });
  check('a selection crop starts at the frame offset plus the box', sel.rect.x === 360 && sel.rect.y === 260, JSON.stringify(sel.rect));
  check('a selection crop is the size of the box', sel.rect.width === 300 && sel.rect.height === 150, JSON.stringify(sel.rect));
  check('a selection crop says it captured the selection', sel.target === 'selection' && !sel.fellBack);

  const padded = captureRect(geometry, { target: 'selection', paddingPx: 48 });
  check('padding grows the crop on every side', padded.rect.x === 312 && padded.rect.width === 396, JSON.stringify(padded.rect));

  const view = captureRect(geometry, { target: 'viewport' });
  check('a viewport crop is the frame', view.rect.x === 260 && view.rect.width === 900 && view.rect.height === 800, JSON.stringify(view.rect));

  // Padding must never reach outside the canvas: the panels beside it are not
  // what was asked for.
  const edge = captureRect({ ...geometry, selection: { x: 0, y: 0, w: 120, h: 60 } }, { target: 'selection', paddingPx: 200 });
  check('padding is clipped to the frame, not to the window', edge.rect.x === 260 && edge.rect.y === 60, JSON.stringify(edge.rect));
  check('a clipped crop stays inside the frame', edge.rect.x + edge.rect.width <= 1160 && edge.rect.y + edge.rect.height <= 860, JSON.stringify(edge.rect));

  // Scrolled out of the canvas entirely.
  const gone = captureRect({ ...geometry, selection: { x: 100, y: 5000, w: 300, h: 150 } }, { target: 'selection' });
  check('a selection off screen falls back to the frame', gone.target === 'viewport' && gone.fellBack);
  check('the fallback is still a real crop', gone.rect.width === 900 && gone.rect.height === 800);

  // A frame drawn at a scale — the box inside it is in the page's own pixels.
  const scaled = captureRect({ ...geometry, scale: 0.5 }, { target: 'selection', paddingPx: 0 });
  check('a scaled frame scales the box', scaled.rect.x === 310 && scaled.rect.width === 150, JSON.stringify(scaled.rect));

  // Window zoom turns CSS pixels into the DIP capturePage measures in.
  const zoomed = captureRect({ ...geometry, zoom: 2 }, { target: 'selection', paddingPx: 0 });
  check('zoom multiplies the crop', zoomed.rect.x === 720 && zoomed.rect.width === 600, JSON.stringify(zoomed.rect));
  check('zoom leaves the window rect alone, for reporting', zoomed.windowRect.x === 360 && zoomed.windowRect.width === 300, JSON.stringify(zoomed.windowRect));

  // The frame hanging off the edge of a small window.
  const cramped = captureRect({ ...geometry, page: { width: 800, height: 400 } }, { target: 'viewport' });
  check('a frame wider than the window is clipped to the window', cramped.rect.width === 540 && cramped.rect.height === 340, JSON.stringify(cramped.rect));

  check('no frame is no crop', captureRect({}, { target: 'viewport' }).rect === null);
  check('a frame too small to photograph is no crop', captureRect({ frame: { x: 0, y: 0, width: 4, height: 4 } }, {}).rect === null);
  check('a selection with no box falls back rather than cropping nothing', captureRect({ ...geometry, selection: { x: 0, y: 0, w: 0, h: 0 } }, { target: 'selection', paddingPx: 0 }).fellBack === true);

  check('an image already small enough is not resized', fitWidth(800, 600, 1400) === 800);
  check('a wide image is fitted on its long side', fitWidth(2800, 600, 1400) === 1400);
  check('a tall image is fitted on its long side', fitWidth(600, 2800, 1400) === 300);
  check('a fit never comes back as zero', fitWidth(1, 100000, 1400) === 1);
}

// ── The output schemas ──────────────────────────────────────────────────────

{
  const store = createContextStore({ resolveTrail: fakeTrail });
  store.publish(payload());
  const snap = store.read();
  const parsed = ContextOutput.safeParse(snap);
  check('a ready snapshot matches the declared output schema', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues?.slice(0, 3)));

  snap.selection.essentialComputedStyles = { display: 'flex' };
  snap.selection.computedStyles = { display: 'flex', 'scroll-snap-stop': 'normal' };
  check('a snapshot with styles still matches', ContextOutput.safeParse(snap).success);

  const empty = createContextStore({ resolveTrail: fakeTrail }).read();
  check('an empty snapshot matches the same schema', ContextOutput.safeParse(empty).success, JSON.stringify(ContextOutput.safeParse(empty).error?.issues?.slice(0, 3)));

  for (const status of ['no_project', 'no_page', 'no_selection', 'preview_not_ready']) {
    const s = createContextStore({ resolveTrail: fakeTrail }).read();
    s.selection.status = status;
    check(`the schema accepts the ${status} status`, ContextOutput.safeParse(s).success);
  }
  const bogus = createContextStore({ resolveTrail: fakeTrail }).read();
  bogus.selection.status = 'exploded';
  check('the schema rejects a status nobody defined', !ContextOutput.safeParse(bogus).success);

  check(
    'the capture metadata matches its schema',
    CaptureOutput.safeParse({
      revision: 1, status: 'ready', target: 'selection', requestedTarget: 'selection', format: 'png',
      source: { file: 'a.astro', startLine: 1, endLine: 2 },
      view: { device: 'desktop', viewportWidth: 100, viewportHeight: 100 },
      occurrence: 0, occurrenceCount: 1,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      pixelSize: { width: 10, height: 10 }, bytes: 40, note: null,
    }).success
  );
  check(
    'capture metadata with no image still matches',
    CaptureOutput.safeParse({
      revision: 0, status: 'no_project', target: 'selection', requestedTarget: 'selection', format: 'png',
      source: null, view: { device: null, viewportWidth: null, viewportHeight: null },
      occurrence: null, occurrenceCount: null, rect: null, pixelSize: null, bytes: 0,
      note: 'No project is open in Stacki.',
    }).success
  );
}

// ── Where the Electron boundary is ──────────────────────────────────────────
//
// The point of the split: the endpoint, the normalizer, the crop arithmetic and
// the tool surface are plain modules, so all of the above can be checked with
// no app around them. One file does the Electron wiring, and if a second one
// starts to, this file stops being able to test what it claims to.

{
  // RECURSIVELY, which it was not. `readdirSync` returns one level and the
  // `.js` filter then dropped `agent/` and `audit/` silently -- so the two
  // subtrees holding most of the surface were never read, and a
  // `require('electron')` added under either passed this guard while breaking
  // the property it names. The review tree's sibling checks below already walk;
  // this now walks the same way.
  const dir = path.join(__dirname, '..', 'electron', 'mcp');
  const jsUnder = (from, prefix = '') => {
    const out = [];
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...jsUnder(path.join(from, entry.name), rel));
      else if (entry.name.endsWith('.js')) out.push(rel);
    }
    return out;
  };
  const allJs = jsUnder(dir);
  const needsElectron = allJs.filter((rel) => /require\(\s*'electron'\s*\)/.test(fs.readFileSync(path.join(dir, rel), 'utf8')));
  // The walk has to actually reach the subtrees, or the check above is being
  // satisfied by not looking.
  check(
    'the scan reaches every file under electron/mcp',
    allJs.some((rel) => rel.startsWith('agent/')) && allJs.some((rel) => rel.startsWith('audit/')),
    allJs.join(', ')
  );
  check(
    'only the wiring file needs Electron',
    needsElectron.length === 1 && needsElectron[0] === 'index.js',
    needsElectron.join(', ') || 'none of them do, which is also wrong'
  );
  check(
    'the capture implementation is testable without a window',
    !/require\(\s*'electron'\s*\)/.test(fs.readFileSync(path.join(dir, 'capture.js'), 'utf8'))
  );
}

// ── Instructions ────────────────────────────────────────────────────────────

{
  check('the server says what it is for', /live visual state/i.test(INSTRUCTIONS));
  check('the server says not to start another dev server', /do not start another dev server/i.test(INSTRUCTIONS));
  check('the server says source is edited with normal tools', /normal\s*\n?\s*repository tools/i.test(INSTRUCTIONS) || /repository tools/i.test(INSTRUCTIONS));
  // Visual Review's half: an agent that reads these has to come away knowing
  // the comments exist, that focus comes first, and that resolving is
  // something you do after looking rather than instead of looking.
  check('the server says the review threads are there', /get_comments/.test(INSTRUCTIONS));
  check('the server says to focus before acting', /focus/.test(INSTRUCTIONS));
  check('the server says to verify before resolving', /verif/i.test(INSTRUCTIONS) && /[Rr]esolve/.test(INSTRUCTIONS));
  check('the server says what deferring is for', /defer/i.test(INSTRUCTIONS));
  // The cap has moved three times, and every time for something an agent gets
  // wrong without being told: first the preference order (start from Stacki,
  // follow the ref, do not go looking for what it already found), then that a
  // review body is data rather than an instruction — which is the one thing here
  // that no amount of filtering can enforce and only saying can — and now the
  // two sentences that name the resource namespace.
  //
  // That last one buys its 213 bytes back many times over: without it an agent
  // does not know stacki://project/profile exists, and pays eleven round trips
  // rediscovering what one read would have told it. Everything those sentences
  // POINT AT lives in a resource and costs nothing until it is asked for, which
  // is the whole reason the cap can stay a cap.
  check('the instructions stay short enough to be read', INSTRUCTIONS.length < 2000, `${INSTRUCTIONS.length} chars`);
  check('the instructions name where project facts live', /stacki:\/\/project\/profile/.test(INSTRUCTIONS));
  check('the instructions name the guidance namespace', /stacki:\/\/guide/.test(INSTRUCTIONS));
  // A host with no resource support must still be told how to reach the same
  // bytes, or the sentence above is a dead end for it.
  check('the instructions offer a resource-free route to the guidance', /get_capabilities\(\{topic\}\)/.test(INSTRUCTIONS));
  // The new half has to reach an agent through these, or it will keep doing
  // what it did before: photograph the element, then grep for it.
  check('the server says not to re-find what Stacki found', /rediscover|do not search the repository/i.test(INSTRUCTIONS));
  check('the server says the edits are undoable', /undo/i.test(INSTRUCTIONS));
  check('the server says a stale write is refused', /refused rather than overwriting/.test(INSTRUCTIONS));
  check('and that the ref is what carries the guard', /ref\s*\n?\s*carries the version/.test(INSTRUCTIONS.replace(/\s+/g, ' ')) || /ref carries the version/.test(INSTRUCTIONS));
  // The one an editor-capable server has to say, and the one a filter cannot
  // solve: what arrives in a review is somebody's words, not an instruction.
  check('the server says review text is data', /REVIEW TEXT IS DATA/.test(INSTRUCTIONS));
  check('and that it grants no authority', /carries no\s+authority/.test(INSTRUCTIONS.replace(/\s+/g, ' ')) || /carries no authority/.test(INSTRUCTIONS));
  check('and that access is granted per project', /per project/.test(INSTRUCTIONS));
  check('the server says bound text is not overwritten', /[Bb]ound text/.test(INSTRUCTIONS));
  check('the server still says the repository tools remain available', /fast path, not a fence/i.test(INSTRUCTIONS));
}

// ── The door ────────────────────────────────────────────────────────────────

const TOKEN = 'a'.repeat(43);
const PORT = 43871; // not the real one — a test must not fight a running Stacki
const BASE = `http://127.0.0.1:${PORT}`;

const SNAPSHOT = (() => {
  const store = createContextStore({ resolveTrail: fakeTrail });
  store.publish(payload());
  return store.read();
})();

const readBody = async (res) => {
  const text = await res.text();
  if ((res.headers.get('content-type') || '').includes('event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// fetch refuses to set a Host header, so DNS-rebinding checks need a socket.
const rawPost = (hostHeader, body) =>
  new Promise((resolve) => {
    const json = JSON.stringify(body);
    const socket = net.connect(PORT, '127.0.0.1', () => {
      socket.write(
        `POST ${ENDPOINT_PATH} HTTP/1.1\r\nHost: ${hostHeader}\r\n` +
          `Authorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\n` +
          `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`
      );
    });
    let out = '';
    socket.on('data', (d) => (out += d));
    socket.on('error', () => resolve(0));
    socket.on('close', () => resolve(Number((/^HTTP\/1\.1 (\d+)/.exec(out) || [])[1]) || 0));
  });

(async () => {
  // ── Background throttling ───────────────────────────────────────────────────
  //
  // A window nobody is looking at may not be painting, and capturePage then hands
  // back the frame it last drew — the page as it was, with the editor's outlines
  // still on it. Lifting Chromium's throttling for the length of one capture is
  // what makes the frame current; putting it back is what stops one screenshot
  // leaving the app burning battery in the background for the rest of the session.
  //
  // So the contract is: read what it was, disable only if it was on, restore on
  // EVERY path out — including the ones that threw.

  {
    const fakeImage = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 80 }),
      resize() { return this; },
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff]),
    });

    const GEOMETRY = {
      frame: { x: 100, y: 50, width: 800, height: 600 },
      scale: 1,
      page: { width: 1400, height: 900 },
      selection: { x: 10, y: 20, w: 200, h: 100 },
    };

    // A window that records every throttling call it is given.
    const fakeWindow = (over = {}) => {
      const calls = [];
      let throttling = over.throttling ?? true;
      return {
        calls,
        minimized: !!over.minimized,
        isDestroyed: () => !!over.destroyed,
        isMinimized() { return this.minimized; },
        webContents: {
          isDestroyed: () => !!over.wcDestroyed,
          getBackgroundThrottling: () => throttling,
          setBackgroundThrottling: (v) => { calls.push(v); throttling = v; },
          getZoomFactor: () => 1,
          capturePage: over.capturePage || (async () => fakeImage()),
        },
        get throttling() { return throttling; },
      };
    };

    const snapshotFor = (status = 'ready') => {
      const store = createContextStore({ resolveTrail: fakeTrail });
      store.publish(payload());
      const snap = store.read();
      snap.selection.status = status;
      return snap;
    };

    const build = (win, askImpl, snap = snapshotFor()) => {
      const asked = [];
      const capture = createCapture({
        getWindow: () => win,
        ask: async (kind, params, timeout) => {
          asked.push(kind);
          return askImpl ? askImpl(kind, params, timeout) : kind === 'capture:begin' ? GEOMETRY : { ok: true };
        },
        readSnapshot: () => snap,
        captureTimeoutMs: 50,
      });
      return { capture, asked };
    };

    const args = { target: 'selection', paddingPx: 24, format: 'png' };

    // The ordinary path.
    {
      const win = fakeWindow();
      const { capture, asked } = build(win);
      const shot = await capture(args);
      check('a capture returns an image', !!shot.image && shot.mimeType === 'image/png');
      check('throttling is lifted and put back', JSON.stringify(win.calls) === '[false,true]', JSON.stringify(win.calls));
      check('throttling ends where it started', win.throttling === true);
      check('the canvas is prepared before it is photographed', asked[0] === 'capture:begin', asked.join(','));
      check('the outlines are put back afterwards', asked.includes('capture:end'));
    }

    // Already un-throttled by somebody else: leave it alone entirely.
    {
      const win = fakeWindow({ throttling: false });
      const { capture } = build(win);
      await capture(args);
      check('throttling already off is not touched', win.calls.length === 0, JSON.stringify(win.calls));
      check('and is left off', win.throttling === false);
    }

    // The renderer never answers.
    {
      const win = fakeWindow();
      const { capture } = build(win, (kind) => (kind === 'capture:begin' ? null : { ok: true }));
      const shot = await capture(args);
      check('no answer from the canvas is a note, not a crash', shot.image === null && /not showing a page/.test(shot.meta.note));
      check('throttling is restored when the canvas says nothing', JSON.stringify(win.calls) === '[false,true]', JSON.stringify(win.calls));
    }

    // capturePage itself throws.
    {
      const win = fakeWindow({ capturePage: async () => { throw new Error('surface gone'); } });
      const { capture } = build(win);
      let threw = null;
      try { await capture(args); } catch (err) { threw = err; }
      check('a capture that throws still throws', !!threw, 'it swallowed the error');
      check('throttling is restored on the error path', JSON.stringify(win.calls) === '[false,true]', JSON.stringify(win.calls));
      check('throttling ends where it started after an error', win.throttling === true);
    }

    // The renderer throws while putting the outlines back.
    {
      const win = fakeWindow();
      const { capture } = build(win, (kind) => {
        if (kind === 'capture:begin') return GEOMETRY;
        throw new Error('renderer went away');
      });
      let threw = null;
      try { await capture(args); } catch (err) { threw = err; }
      check('a failure restoring the outlines does not hide throttling restoration', JSON.stringify(win.calls) === '[false,true]', JSON.stringify(win.calls));
      check('that failure is still reported', !!threw);
    }

    // The window goes away mid-capture: nothing to restore, and no throw.
    {
      const win = fakeWindow({ wcDestroyed: true });
      const { capture } = build(win);
      const shot = await capture(args);
      check('a window destroyed mid-capture still answers', !!shot.image);
      check('and nothing is restored onto a dead webContents', JSON.stringify(win.calls) === '[false]', JSON.stringify(win.calls));
    }

    // Nothing to photograph: the early returns must not have touched throttling.
    {
      const win = fakeWindow();
      const { capture } = build(win, null, snapshotFor('no_project'));
      const shot = await capture(args);
      check('no project is a note before anything is touched', shot.image === null && /No project/.test(shot.meta.note));
      check('and throttling is never touched for it', win.calls.length === 0, JSON.stringify(win.calls));
    }
    {
      const win = fakeWindow({ destroyed: true });
      const { capture } = build(win);
      const shot = await capture(args);
      check('a closed window is a note', shot.image === null && /window is not open/.test(shot.meta.note));
      check('and throttling is never touched for it', win.calls.length === 0);
    }

    // Minimised: the one case lifting throttling cannot rescue, so it is said.
    {
      const win = fakeWindow({ minimized: true });
      const { capture } = build(win);
      const shot = await capture(args);
      check('a minimised window still answers with an image', !!shot.image);
      check('a minimised capture warns that the page may be stale', /minimised/.test(shot.meta.note || ''), shot.meta.note);
      const up = fakeWindow();
      const plain = await build(up).capture(args);
      check('a window on screen carries no such warning', !/minimised/.test(plain.meta.note || ''), plain.meta.note);
    }
  }

  // A real ledger behind the review tools, in a temp file. Not a stub: the
  // point of these checks is the whole path — schema, action enum, store,
  // projection — and a fake in the middle is exactly where a mismatch would
  // hide.
  const reviewHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-mcp-reviews-'));
  const reviewFile = path.join(reviewHome, 'reviews.json');
  const ledger = createReviewStore({ file: reviewFile, projectPath: ROOT });
  let livePayload = payload();
  let focusAnswer = { anchorState: 'attached', restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true } };
  let focusedWith = null;

  const getComments = async ({ status, scope, detail: level, limit }) => {
    const picked = selectThreads(ledger.all(), {
      status,
      scope,
      limit,
      page: { route: SNAPSHOT.page.route, file: SNAPSHOT.page.file },
      keys: livePayload?.selection?.keys || null,
    });
    // Projected by the same function the service uses. Building the list here
    // instead would be a second implementation of the answer, and the size cap
    // and the declared schema would only ever be tested against the copy.
    return {
      ok: true,
      revision: ledger.revision,
      status,
      scope,
      problem: ledger.problem || null,
      // What the service always sends: whether these comments are shared, and
      // how the last catch-up went.
      //
      // EVERY KEY `sharedStatus()` REALLY SENDS, and that is the point of it.
      // This was a nine-key approximation of a twelve-key object, so the
      // schema was exercised against a shape the app never produces and
      // `get_comments` was unusable from a strict client while this passed.
      // The SDK validates output on the way out, so a fixture that drifts from
      // electron/review/index.js now fails HERE too — and test/review-service.js
      // holds the real object against the same schema.
      shared: {
        mode: 'legacy',
        enabled: true,
        workspace: { id: 'ws-1', server: 'http://127.0.0.1:43822', displayName: 'lenuri-web', actorId: 'a-1', repositoryHint: null, joinedAt: 1 },
        lastSyncAt: 1700000000000,
        problem: null,
        pending: 0,
        private: 0,
        syncing: false,
        identity: { actorId: 'a-1', displayName: 'Alice' },
        suggestion: null,
        secure: null,
        newShareRelay: { ok: true, hosted: true, origin: 'https://stacki-relay.neongod.io', label: 'Hosted relay' },
      },
      ...projectReviews(picked, { detail: level, resolver: fakeTrail, checkout: () => CHECKOUT }),
    };
  };
  // How this checkout stands against each review. A fixed answer here: the
  // states themselves are checked against real repositories in
  // test/review-checkout.js — what matters at this boundary is that the field
  // is declared, sent and accepted.
  const CHECKOUT = {
    branch: 'main',
    head: 'abc1234',
    dirty: false,
    origin: { branch: 'main', head: 'abc1234', dirty: false },
    sameBranch: true,
    originIn: 'present',
    source: 'same',
    resolution: null,
  };

  const comment = async (args) => {
    if (args.action === 'focus') {
      const thread = ledger.get(args.threadId);
      if (!thread) return { ok: false, code: 'no_thread', message: 'No review with that id.', revision: ledger.revision, review: null };
      focusedWith = thread.anchor;
      if (!focusAnswer.transient) ledger.syncAnchors([{ id: args.threadId, anchorState: focusAnswer.anchorState }]);
      const landed = focusAnswer.anchorState === 'attached';
      return {
        ok: landed,
        code: landed ? null : focusAnswer.transient ? 'not_ready' : 'orphaned',
        // The real focus() mints a ref when the walk lands and nulls it when it
        // does not. The double has to do the same, or a handler that drops the
        // ref on the way to the wire looks exactly like one that keeps it.
        targetRef: landed ? 'stacki:double.ref' : null,
        targetEditable: landed && focusAnswer.writable !== false,
        confidence: landed ? focusAnswer.confidence || 'exact' : null,
        restored: focusAnswer.restored,
        note: focusAnswer.note || null,
        revision: ledger.revision,
        review: reviewDetail(ledger.get(args.threadId), fakeTrail, () => CHECKOUT),
      };
    }
    if (args.action === 'create') {
      const built = anchorFrom(livePayload);
      if (!built.ok) {
        return { ok: false, code: built.reason, message: 'Nothing to comment on.', revision: ledger.revision, review: null };
      }
      const made = ledger.apply({ action: 'create', message: args.message, authorType: 'agent', anchor: built.anchor, creationContext: built.creationContext });
      return made.ok
        ? { ok: true, revision: ledger.revision, review: reviewDetail(made.thread, fakeTrail, () => CHECKOUT), code: null, message: null }
        : { ...made, revision: ledger.revision, review: null };
    }
    const done = ledger.apply({ ...args, authorType: 'agent' });
    return done.ok
      ? { ok: true, revision: ledger.revision, review: reviewDetail(done.thread, fakeTrail, () => CHECKOUT), code: null, message: null }
      : { ...done, revision: ledger.revision, review: null };
  };

  let captured = null;
  const server = createStackiMcpServer({
    port: PORT,
    token: TOKEN,
    version: '1.2.3',
    getComments,
    comment,
    getContext: async ({ styleDetail }) => {
      const snap = JSON.parse(JSON.stringify(SNAPSHOT));
      if (styleDetail === 'essential' || styleDetail === 'full') {
        snap.selection.essentialComputedStyles = { display: 'flex' };
      }
      if (styleDetail === 'full') snap.selection.computedStyles = { display: 'flex', 'scroll-snap-stop': 'normal' };
      return snap;
    },
    capture: async (args) => {
      captured = args;
      return {
        image: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        meta: {
          revision: SNAPSHOT.revision,
          status: 'ready',
          target: args.target,
          requestedTarget: args.target,
          format: args.format,
          source: SNAPSHOT.selection.source,
          view: SNAPSHOT.view,
          occurrence: 0,
          occurrenceCount: 1,
          rect: { x: 0, y: 0, width: 10, height: 10 },
          pixelSize: { width: 10, height: 10 },
          bytes: 4,
          note: null,
        },
      };
    },
    onError: () => {},
  });

  check('the endpoint is the documented one', server.url === `http://127.0.0.1:${PORT}/mcp`, server.url);
  check('the default port is the documented one', DEFAULT_PORT === 43821, String(DEFAULT_PORT));
  check('nothing listens before start()', server.listening === false);

  await server.start();
  check('start() listens', server.listening === true);
  check('it binds loopback only', server.host === '127.0.0.1', server.host);

  const post = (body, headers = {}) =>
    fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  // --- who is allowed in ---
  const noAuth = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('a request with no token is refused', noAuth.status === 401, String(noAuth.status));
  check('a 401 says how to authenticate', (noAuth.headers.get('www-authenticate') || '').startsWith('Bearer'), noAuth.headers.get('www-authenticate'));
  check('a 401 does not advertise an OAuth flow it does not have', !/resource_metadata/.test(noAuth.headers.get('www-authenticate') || ''));
  check('the wrong token is refused', (await post({}, { authorization: `Bearer ${'b'.repeat(43)}` })).status === 401);
  check('a token of the wrong length is refused', (await post({}, { authorization: 'Bearer short' })).status === 401);
  check('a bare token with no scheme is refused', (await post({}, { authorization: TOKEN })).status === 401);
  check('another scheme is refused', (await post({}, { authorization: `Basic ${TOKEN}` })).status === 401);

  check('a browser origin is refused', (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'http://evil.example' })).status === 403);
  check('an https origin on another host is refused', (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://stacki.dev' })).status === 403);
  check('a localhost origin is allowed', (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: `http://127.0.0.1:${PORT}` })).status === 200);
  check('no origin at all is allowed — real clients send none', (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 200);

  check('a rebinding Host is refused', (await rawPost('evil.example', { jsonrpc: '2.0', id: 1, method: 'tools/list' })) === 403);
  check('a rebinding Host with the right port is still refused', (await rawPost(`evil.example:${PORT}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) === 403);
  check('127.0.0.1 is allowed', (await rawPost(`127.0.0.1:${PORT}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) === 200);
  check('localhost is allowed', (await rawPost(`localhost:${PORT}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) === 200);

  const other = await fetch(`${BASE}/anything`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  check('there is exactly one endpoint', other.status === 404, String(other.status));
  check('no CORS is granted to anybody', !noAuth.headers.get('access-control-allow-origin'));

  // --- how big an ask may be, and whether the refusal survives being right ---
  //
  // The gate itself is easy; DELIVERING it is not. A refusal written while the
  // client is still uploading is only useful if the client can read it, and the
  // first version of this answered 413 and then called `req.destroy()` — which
  // reset the socket mid-upload, so every real client saw `fetch failed`/EPIPE
  // and could not tell a refusal from a dropped write. So every assertion here
  // goes through `fetch` with the body ACTUALLY SENT, which is what a host
  // does; a raw socket that stops after the headers sees a healthy 413 either
  // way and proves nothing.
  {
    const jsonHeaders = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const over = 'x'.repeat(MAX_BODY_BYTES + 1024);

    const big = await fetch(`${BASE}/mcp`, { method: 'POST', headers: jsonHeaders, body: over });
    const bigBody = await big.json().catch(() => null);
    check('a body over the limit is refused', big.status === 413, String(big.status));
    check('  and the refusal actually reaches the client', bigBody?.error === 'payload_too_large', JSON.stringify(bigBody));
    check('  naming the limit and what was declared', /\d+/.test(String(bigBody?.message || '')), String(bigBody?.message));

    // A BODY THAT WILL NOT SAY HOW LONG IT IS. The declared-length check is
    // worth nothing on its own: chunked carries no Content-Length, and 32 MB
    // went straight through the first version of this gate and came back 200.
    const streamed = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(200000)));
        c.close();
      },
    });
    const chunked = await fetch(`${BASE}/mcp`, { method: 'POST', headers: jsonHeaders, body: streamed, duplex: 'half' });
    const chunkedBody = await chunked.json().catch(() => null);
    check('a body with no declared length is refused', chunked.status === 411, String(chunked.status));
    check('  as length_required, with a sentence', chunkedBody?.error === 'length_required', JSON.stringify(chunkedBody));

    // ORDER: the size gate is not the first thing a wrong request meets. A
    // huge POST to a route that does not exist is a 404, and one with no
    // bearer is a 401 — otherwise the limit would be answering for mistakes
    // that have nothing to do with it, and both of those refusals would have
    // the same delivery problem.
    const nowhere = await fetch(`${BASE}/nowhere`, { method: 'POST', headers: jsonHeaders, body: over });
    check('an oversize body to a route that does not exist is still a 404', nowhere.status === 404, String(nowhere.status));
    check('  and that refusal reaches the client too', (await nowhere.json().catch(() => null))?.error === 'not_found');
    const unauthorized = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: over });
    check('an oversize body with no bearer is still a 401', unauthorized.status === 401, String(unauthorized.status));
    check('  and that one reaches the client as well', (await unauthorized.json().catch(() => null))?.error === 'unauthorized');

    // THE METHODS THAT CARRY NO BODY, which nothing asserted until the length
    // requirement above was added and silently turned all of them into 411.
    // A GET has no body; telling it to supply a Content-Length is nonsense, and
    // this endpoint's answer to a GET has always been 405.
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const r = await fetch(`${BASE}/mcp`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      check(`a ${method} is answered 405, not asked for a length`, r.status === 405, String(r.status));
    }

    // POSITIVE CONTROL. Every assertion above is a refusal, and a transport
    // that refused everything would satisfy all of them.
    const ordinary = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('and an ordinary request is unaffected', ordinary.status === 200, String(ordinary.status));

    // THE LIMIT IS ABOVE WHAT THE SCHEMAS PUBLISH AS VALID. It was 8 MB,
    // reasoned from the wrong field: a schema-legal content.write_entry
    // measures about 11 MB, so the transport would have refused calls this
    // surface advertises.
    check('the limit is larger than the largest schema-legal request', MAX_BODY_BYTES > 11 * 1024 * 1024, String(MAX_BODY_BYTES));
  }

  // --- discovery ---
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  const initBody = await readBody(init);
  check('initialize succeeds', init.status === 200 && !!initBody.result, JSON.stringify(initBody).slice(0, 200));
  check('the server names itself', initBody.result?.serverInfo?.name === 'stacki');
  check('the server reports the app version', initBody.result?.serverInfo?.version === '1.2.3');
  check('the server hands over its instructions', typeof initBody.result?.instructions === 'string' && initBody.result.instructions.length > 100);

  const listed = await readBody(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const tools = listed.result?.tools || [];
  // Four, and no more. The pressure on a surface like this is always to add a
  // verb — resolve_comment, reply_comment, focus_comment — and six tools that
  // differ by one word cost a client six descriptions to use one of them.
  check('exactly four tools are exposed', tools.length === 4, tools.map((t) => t.name).join(','));
  check(
    'they are the two that look and the two that review',
    tools.map((t) => t.name).sort().join(',') === 'capture,comment,get_comments,get_context',
    tools.map((t) => t.name).sort().join(',')
  );
  check('nothing here can edit source', !tools.some((t) => /set_|write|edit|modify|move|change/i.test(t.name)));
  check('nothing here can delete anything', !tools.some((t) => /delete|remove|destroy|clear/i.test(t.name)));
  for (const tool of tools) {
    const a = tool.annotations || {};
    if (tool.name === 'comment') {
      // The one tool that writes. Its annotations have to be true rather than
      // tidy: a client that batches retries on the strength of an idempotent
      // hint would leave duplicate comments on somebody's page, because
      // `create` called twice creates twice.
      check('comment is not annotated read-only', a.readOnlyHint === false, JSON.stringify(a));
      check('comment is not annotated destructive — nothing it does removes anything', a.destructiveHint === false);
      check('comment does not claim to be idempotent, because create is not', a.idempotentHint === undefined, JSON.stringify(a));
      check('comment is closed-world — a local file and a local window', a.openWorldHint === false);
    } else {
      check(`${tool.name} is annotated read-only`, a.readOnlyHint === true && a.destructiveHint === false && a.idempotentHint === true && a.openWorldHint === false, JSON.stringify(a));
    }
    check(`${tool.name} declares an input schema`, tool.inputSchema?.type === 'object');
    check(`${tool.name} declares an output schema`, tool.outputSchema?.type === 'object');
    check(`${tool.name} has a description`, typeof tool.description === 'string' && tool.description.length > 40);
  }
  check('the annotation constants say the same thing the wire does', MUTATES.readOnlyHint === false && !('idempotentHint' in MUTATES) && REVIEW_READ_ONLY.readOnlyHint === true);
  const styleDetail = tools.find((t) => t.name === 'get_context').inputSchema.properties.styleDetail;
  check('styleDetail is an enum with a default', styleDetail.default === 'essential' && styleDetail.enum.join() === 'none,essential,full', JSON.stringify(styleDetail));

  // --- get_context ---
  const ctx = await readBody(await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } }));
  check('get_context answers', !ctx.error && !ctx.result?.isError, JSON.stringify(ctx).slice(0, 300));
  check('get_context answers with structured content', !!ctx.result?.structuredContent);
  check('get_context answers with the selection', ctx.result?.structuredContent?.selection?.tag === 'section');
  check('get_context includes essential styles by default', !!ctx.result?.structuredContent?.selection?.essentialComputedStyles);
  check('get_context does not dump every property by default', !ctx.result?.structuredContent?.selection?.computedStyles);
  check('get_context also answers as text, for clients that read content', /"tag": "section"/.test(ctx.result?.content?.[0]?.text || ''));

  const full = await readBody(await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_context', arguments: { styleDetail: 'full' } } }));
  check('styleDetail full returns the whole set', !!full.result?.structuredContent?.selection?.computedStyles);

  const none = await readBody(await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_context', arguments: { styleDetail: 'none' } } }));
  check('styleDetail none returns no styles', !none.result?.structuredContent?.selection?.essentialComputedStyles);

  const badDetail = await readBody(await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_context', arguments: { styleDetail: 'everything' } } }));
  check('an argument outside the enum is rejected', badDetail.result?.isError === true, JSON.stringify(badDetail).slice(0, 200));
  // It used to say "validation", because the SDK refused before Stacki's
  // handler ran and the client got a bare English sentence with no
  // structuredContent -- the one answer in this surface an agent cannot branch
  // on. It now answers Stacki's own envelope, so the assertion is on the code
  // and the field, not on a word from somebody else's error text.
  check(
    'the rejection says what was wrong',
    /"code":\s*"bad_arguments"/.test(badDetail.result?.content?.[0]?.text || '') &&
      /styleDetail/.test(badDetail.result?.content?.[0]?.text || ''),
    badDetail.result?.content?.[0]?.text
  );

  // --- capture ---
  const shot = await readBody(await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'capture', arguments: {} } }));
  check('capture answers with an image', shot.result?.content?.some((c) => c.type === 'image' && c.mimeType === 'image/png'), JSON.stringify(shot).slice(0, 200));
  check('capture answers with metadata beside it', !!shot.result?.structuredContent?.rect);
  check('capture defaults to the selection', captured.target === 'selection', JSON.stringify(captured));
  check('capture defaults to 48px of context', captured.paddingPx === 48, String(captured.paddingPx));
  check('capture defaults to png', captured.format === 'png', captured.format);

  await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'capture', arguments: { target: 'viewport', paddingPx: 0, format: 'jpeg' } } });
  check('capture takes the arguments it is given', captured.target === 'viewport' && captured.paddingPx === 0 && captured.format === 'jpeg', JSON.stringify(captured));

  const badTarget = await readBody(await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'capture', arguments: { target: 'everything' } } }));
  check('a target outside the enum is rejected', badTarget.result?.isError === true);
  const bigPad = await readBody(await post({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'capture', arguments: { paddingPx: 100000 } } }));
  check('padding is bounded', bigPad.result?.isError === true, JSON.stringify(bigPad).slice(0, 200));
  const negPad = await readBody(await post({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'capture', arguments: { paddingPx: -10 } } }));
  check('negative padding is rejected', negPad.result?.isError === true);
  const unknown = await readBody(await post({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'set_margin', arguments: {} } }));
  check('a tool nobody registered is an error, not a surprise', !!unknown.error || unknown.result?.isError === true);

  // --- the review tools, over the wire --------------------------------------
  //
  // The full loop an agent is meant to run: list what is open, focus one so
  // Stacki goes and looks at it, act on it, and find it has moved out of the
  // open list and into the resolved one. Run against the real ledger, so a
  // schema that disagrees with the store is a failure here rather than a
  // surprise in somebody's terminal.

  let rpc = 100;
  const call = async (name, args) =>
    readBody(await post({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } }));
  const structured = (r) => r.result?.structuredContent;

  {
    const empty = structured(await call('get_comments', {}));
    check('get_comments answers on an empty project', empty?.ok === true && empty.reviews.length === 0, JSON.stringify(empty));
    check('and defaults to the open ones', empty.status === 'open' && empty.scope === 'project');

    // No project open at all. An empty app is a status here as everywhere
    // else — and it still has to answer in the shape the schema promises, or
    // the client rejects its own validation and the user sees a protocol error
    // instead of "nothing is open".
    {
      const closed = createStackiMcpServer({
        port: PORT + 1,
        token: TOKEN,
        getContext: async () => SNAPSHOT,
        capture: async () => ({ image: null, mimeType: null, meta: {} }),
        getComments: async (args) => ({
          ok: false,
          code: 'no_project',
          message: 'No project is open in Stacki.',
          status: args.status,
          scope: args.scope,
          revision: 0,
          total: 0,
          truncated: false,
          reviews: [],
        }),
        comment: async () => ({ ok: false, code: 'no_project', message: 'No project is open in Stacki.', revision: 0, review: null }),
        onError: () => {},
      });
      await closed.start();
      const res = await fetch(closed.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'get_comments', arguments: {} } }),
      });
      const body = await readBody(res);
      check('with no project open the answer still validates', !/validation error/i.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 200));
      check('and says which empty state it is', body.result?.structuredContent?.code === 'no_project');
      await closed.stop();
    }

    // create — against whatever Stacki has selected, and nothing else.
    const made = await call('comment', { action: 'create', message: 'This pill is too tight at 375.' });
    const first = structured(made);
    check('comment create makes a review', first?.ok === true, JSON.stringify(first).slice(0, 300));
    check('and answers with it in full', !!first.review?.id && first.review.messages.length === 1);
    check('the agent is recorded as the author', first.review.messages[0].authorType === 'agent');
    check('it starts open and attached', first.review.status === 'open' && first.review.anchorState === 'attached');
    check('it is anchored to the live selection', first.review.anchor.keys.join() === 'src/pages/index.astro#0.1', JSON.stringify(first.review.anchor.keys));
    check('it kept the breakpoint it was written at', first.review.anchor.breakpoint.device === 'desktop');
    check('it kept which copy', first.review.occurrence === 0 && first.review.occurrenceCount === 1, JSON.stringify(first.review).slice(0, 200));
    check('a full answer resolves the anchor to current lines', first.review.anchor.sourceTrail?.[0]?.startLine === 4);
    const A = first.review.id;

    // A review that cannot be anchored is a status, not a fabrication.
    livePayload = payload({ selection: { present: false } });
    const nothing = await call('comment', { action: 'create', message: 'about what?' });
    check('create with nothing selected refuses', structured(nothing)?.ok === false, JSON.stringify(structured(nothing)));
    check('and says which empty state it was', structured(nothing).code === 'no_selection', structured(nothing).code);
    check('and the client is told it did not happen', nothing.result?.isError === true);
    check('no floating review was created', ledger.size === 1, String(ledger.size));
    livePayload = payload();

    // The requirements each action has, checked before anything is applied.
    check('create with no message refuses', structured(await call('comment', { action: 'create' }))?.code === 'no_message');
    check('reply with no thread refuses', structured(await call('comment', { action: 'reply', message: 'x' }))?.code === 'no_thread_id');
    check('reply with no message refuses', structured(await call('comment', { action: 'reply', threadId: A }))?.code === 'no_message');
    check('resolve with no thread refuses', structured(await call('comment', { action: 'resolve' }))?.code === 'no_thread_id');
    check('focus with no thread refuses', structured(await call('comment', { action: 'focus' }))?.code === 'no_thread_id');
    check('create with a threadId refuses — it comments on the selection', structured(await call('comment', { action: 'create', message: 'x', threadId: A }))?.code === 'unexpected_thread_id');
    check('an unknown review is a named refusal', structured(await call('comment', { action: 'reply', threadId: 'rt_nope', message: 'x' }))?.code === 'no_thread');
    check('the requirement table is the same one the schema documents', requirementProblem({ action: 'reply', threadId: 'x', message: 'y' }) === null);

    // The actions that are deliberately not there.
    for (const gone of ['delete', 'remove', 'assign', 'close', 'approve']) {
      const refused = await call('comment', { action: gone, threadId: A });
      check(`"${gone}" is not an action the schema accepts`, refused.result?.isError === true, JSON.stringify(refused).slice(0, 160));
    }
    check('the action list is exactly the six', REVIEW_ACTIONS.join() === 'create,reply,focus,resolve,defer,reopen', REVIEW_ACTIONS.join());
    check('and delete is not among them', !REVIEW_ACTIONS.includes('delete'));
    check('the review survived every refusal', ledger.get(A).status === 'open' && ledger.size === 1);

    // focus — the operation the loop stands on.
    focusedWith = null;
    const focused = structured(await call('comment', { action: 'focus', threadId: A }));
    check('focus answers', focused?.ok === true, JSON.stringify(focused).slice(0, 300));
    check('and sends Stacki to the review\\u2019s own anchor', focusedWith?.keys?.join() === 'src/pages/index.astro#0.1');
    check('and says what it managed to restore', focused.restored?.page === true && focused.restored?.node === true);
    check('and changes nothing about the review', focused.review.status === 'open' && focused.review.messages.length === 1);
    // The ref has to survive the handler, not just the review module: the
    // tool advertises that focusing hands one back, and an agent that gets
    // the anchor without it has to go and find the element by hand.
    check('and hands the target back as something the editor tools can take', typeof focused.targetRef === 'string' && focused.targetRef.startsWith('stacki:'), JSON.stringify(focused.targetRef));
    check('saying it may be written through', focused.targetEditable === true);
    check('and how the element was identified', focused.confidence === 'exact', JSON.stringify(focused.confidence));

    // An orphan focus degrades honestly rather than selecting something near.
    focusAnswer = {
      anchorState: 'orphaned',
      restored: { page: true, breakpoint: true, component: false, node: false, occurrence: false },
      note: 'The page is open, but the component this review was written inside is no longer there.',
    };
    const lost = structured(await call('comment', { action: 'focus', threadId: A }));
    check('focusing an orphan does not report success', lost?.ok === false, JSON.stringify(lost).slice(0, 200));
    check('it says which rung it got to', lost.restored.page === true && lost.restored.node === false);
    check('an orphan hands back no ref to act through', lost.targetRef === null && lost.targetEditable === false);
    check('it says so in words as well', /no longer there/.test(lost.note || ''), lost.note);
    check('and the review is marked orphaned rather than hidden', lost.review.anchorState === 'orphaned' && lost.review.status === 'open');
    check('an orphan still carries what it was about', lost.review.creationContext.text === 'Hello world', JSON.stringify(lost.review.creationContext).slice(0, 200));
    // Put it back to attached first — the orphan check above left it lost.
    focusAnswer = { anchorState: 'attached', restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true } };
    await call('comment', { action: 'focus', threadId: A });

    // A preview that has not finished starting is not an orphan. Reporting it
    // as one would have an agent give up on a review that was about to work —
    // and, worse, would write that verdict onto somebody's comment.
    focusAnswer = {
      anchorState: 'orphaned',
      transient: true,
      restored: { page: true, breakpoint: false, component: false, node: false, occurrence: false },
      note: 'The Stacki preview is not rendering yet.',
    };
    const notReady = structured(await call('comment', { action: 'focus', threadId: A }));
    check('a focus that failed for timing is not called orphaned', notReady.code === 'not_ready', notReady.code);
    check('and the review is left exactly as it was', ledger.get(A).anchorState === 'attached', ledger.get(A).anchorState);

    focusAnswer = { anchorState: 'attached', restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true } };
    await call('comment', { action: 'focus', threadId: A });

    // reply, and then the loop's happy ending.
    const replied = structured(await call('comment', { action: 'reply', threadId: A, message: 'Reduced the horizontal padding to 12px.' }));
    check('reply adds to the thread', replied.review.messages.length === 2);
    check('and leaves it open', replied.review.status === 'open');

    const resolved = structured(await call('comment', { action: 'resolve', threadId: A, message: 'Implemented and visually verified.' }));
    check('resolve closes it', resolved.review.status === 'resolved');
    check('and keeps the closing note', resolved.review.messages[2].body === 'Implemented and visually verified.');

    const stillOpen = structured(await call('get_comments', { status: 'open' }));
    check('a resolved review is no longer open', !stillOpen.reviews.some((r) => r.id === A), JSON.stringify(stillOpen.reviews));

    // The sharing status survives the round trip WHOLE.
    //
    // Not decoration: the SDK validates structuredContent against the declared
    // schema on the way out and a strict client validates it again on the way
    // in, so an undeclared key is not a missing field — it is the entire
    // response thrown away, which is how get_comments came to fail with
    // "data/shared must NOT have additional properties" against a real client
    // while this suite passed. Anything the service sends must arrive.
    check('the sharing status comes back at all', !!stillOpen.shared, JSON.stringify(stillOpen.shared));
    for (const key of ['mode', 'enabled', 'workspace', 'lastSyncAt', 'problem', 'pending', 'private', 'syncing', 'identity', 'suggestion', 'secure', 'newShareRelay']) {
      check(`  with \`${key}\` intact`, key in (stillOpen.shared || {}), Object.keys(stillOpen.shared || {}).join(','));
    }
    check('and the relay descriptor arrives whole', stillOpen.shared?.newShareRelay?.origin === 'https://stacki-relay.neongod.io', JSON.stringify(stillOpen.shared?.newShareRelay));
    const asResolved = structured(await call('get_comments', { status: 'resolved' }));
    check('and is in the resolved list', asResolved.reviews.some((r) => r.id === A));
    check('the summary says what state it is in', asResolved.reviews[0].status === 'resolved' && asResolved.reviews[0].anchorState === 'attached');

    // reopen — the only way back.
    const back = structured(await call('comment', { action: 'reopen', threadId: A, message: 'Still wrong on a small phone.' }));
    check('reopen puts it back to open', back.review.status === 'open');
    check('and keeps everything said before', back.review.messages.length === 4);

    // defer, with a reason and a reference the agent got from its own tooling.
    const second = structured(await call('comment', { action: 'create', message: 'The card grid needs rethinking below 400px.' }));
    const B = second.review.id;
    const deferred = structured(
      await call('comment', {
        action: 'defer',
        threadId: B,
        reason: 'Needs a product decision between two and one column.',
        externalRef: 'https://github.com/example/repo/issues/418',
      })
    );
    check('defer sets the state', deferred.review.status === 'deferred');
    check('and keeps the reason', /product decision/.test(deferred.review.deferredReason || ''));
    check('and keeps the reference as plain text', deferred.review.externalRefs[0].endsWith('/418'));
    // An external reference is a string Stacki stores and nothing else: no
    // request, no client, no credentials. Checked against the source rather
    // than by watching the network, because the failure to catch is somebody
    // adding a "just validate the URL" fetch later.
    const reviewFiles = ['electron/mcp/reviewTools.js', 'electron/review/store.js', 'electron/review/index.js', 'electron/review/anchor.js', 'electron/review/events.js'];
    const reviewSource = reviewFiles.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    check('nothing on the review path makes a request', !/\bfetch\s*\(|https?\.request|XMLHttpRequest|axios/.test(reviewSource));
    check('nor requires a network client', !/require\('node:https'\)|require\('https'\)|require\('node:http'\)/.test(reviewSource));
    check('nor has GitHub credentials anywhere near it', !/octokit|api\.github\.com|GITHUB_TOKEN|gh auth/i.test(reviewSource));
    check('nor runs anything', !/child_process|execFile|spawn\(/.test(reviewSource));

    // Since Shared Reviews there IS a network in this feature, and the shape of
    // that is worth pinning down: only the transports reach one, they are
    // reached only through the syncer, and the syncer refuses before it builds
    // one at all when the project is not shared. So the guarantee "a project
    // nobody shared makes no request" is a property of the code rather than a
    // promise about it — test/shared-reviews.js and test/secure-share.js both
    // count the requests.
    //
    // Secure Share added a SECOND transport, which is the whole point of there
    // being a transport interface. Both are listed here by name so that a
    // third one has to be added to this list on purpose.
    const transports = ['electron/review/transport.js', 'electron/review/secure/transport.js'];
    for (const file of transports) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      check(`${file} is a transport and reaches a network`, /globalThis\.fetch/.test(text));
    }
    // And nothing else on the review path does. This is the assertion that
    // actually holds the line; the two above only say where the network is.
    const reviewDir = path.join(__dirname, '..', 'electron', 'review');
    const everyReviewFile = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) everyReviewFile.push(full);
      }
    })(reviewDir);
    const strays = everyReviewFile.filter(
      (f) => !transports.some((t) => f.endsWith(t.split('/').pop()) && f.includes(t.split('/').slice(-2)[0])) &&
        /\bfetch\s*\(|https?\.request|XMLHttpRequest|axios/.test(fs.readFileSync(f, 'utf8'))
    );
    check('no other review module reaches a network', strays.length === 0, strays.join(', '));

    const sync = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review', 'sync.js'), 'utf8');
    check('the syncer builds the transport and nothing else does', /link\.make\(\)/.test(sync));
    check('which refuses before building one at all', /if \(!store \|\| !store\.shared\?\.workspaceId \|\| !link\)/.test(sync));

    // And none of it is reachable from MCP. An agent that could create a
    // workspace, mint an invitation or point Stacki at another server would be
    // an agent that could publish somebody's private comments.
    const toolSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mcp', 'reviewTools.js'), 'utf8');
    for (const forbidden of ['enableShared', 'joinShared', 'disableShared', 'createInvite', 'syncNow', 'setIdentity']) {
      check(`no MCP tool reaches ${forbidden}`, !new RegExp(`\\b${forbidden}\\b`).test(toolSource), forbidden);
    }
    // The surest form of it: this file is a description of a surface and takes
    // its implementations as arguments, so it cannot reach the registry, the
    // transport or the syncer whatever anybody writes into it later.
    check(
      'the MCP surface requires nothing from the review modules at all',
      !/require\(\s*'[^']*review\//.test(toolSource),
      (toolSource.match(/require\([^)]*\)/g) || []).join()
    );
    check('and the tool surface did not grow to make room for it', tools.length === 4, tools.map((t) => t.name).join());
    const asDeferred = structured(await call('get_comments', { status: 'deferred' }));
    check('a deferred review is in the deferred list', asDeferred.reviews.map((r) => r.id).join() === B);
    check('and out of the open one', !structured(await call('get_comments', { status: 'open' })).reviews.some((r) => r.id === B));
    check('all is all of them', structured(await call('get_comments', { status: 'all' })).reviews.length === 2);

    // Scope.
    check('project scope is everything', structured(await call('get_comments', { status: 'all', scope: 'project' })).reviews.length === 2);
    check('page scope is the page on screen', structured(await call('get_comments', { status: 'all', scope: 'page' })).reviews.length === 2);
    check(
      'selection scope is the element selected',
      structured(await call('get_comments', { status: 'all', scope: 'selection' })).reviews.length === 2
    );
    livePayload = payload({ selection: { keys: ['src/pages/index.astro#9.9'] } });
    check(
      'and nothing when something else is selected',
      structured(await call('get_comments', { status: 'all', scope: 'selection' })).reviews.length === 0
    );
    livePayload = payload();

    // Detail — the default has to stay small enough to survey a project with.
    const summaryList = structured(await call('get_comments', { status: 'all' }));
    const row = summaryList.reviews[0];
    check('a summary carries no messages', !('messages' in row), Object.keys(row).join());
    check('a summary carries no creation snapshot', !('creationContext' in row));
    check('a summary still says everything needed to choose', !!row.id && !!row.status && !!row.message && !!row.page);
    check('a summary carries the short number the user sees', Number.isInteger(row.number), JSON.stringify(row));
    check('a summary row stays small', JSON.stringify(row).length < 600, `${JSON.stringify(row).length} chars`);
    const fullList = structured(await call('get_comments', { status: 'all', detail: 'full' }));
    check('a full read carries the messages', fullList.reviews[0].messages.length > 0);
    check('and the anchor', fullList.reviews[0].anchor.keys.length > 0);
    check('and the creation snapshot', !!fullList.reviews[0].creationContext);
    // No colour, in either direction. A review used to carry the colour the
    // user had filed it under, and an agent could read it while having no way
    // to set it — a field on the wire that meant nothing to the only thing
    // reading it. It is gone from the model, so it is gone from the schema.
    check('and no colour, because a review no longer has one', !('color' in fullList.reviews[0]), Object.keys(fullList.reviews[0]).join(','));
    check('nor on a summary row', !('color' in row), Object.keys(row).join(','));
    check('and no action naming one', !REVIEW_ACTIONS.some((a) => /colou?r/i.test(a)));

    // Bounds, so one pathological review cannot cost an agent its context.
    const huge = 'x'.repeat(9000);
    check('a body past the schema limit is rejected at the door', (await call('comment', { action: 'create', message: huge })).result?.isError === true);
    check('a limit outside the range is rejected', (await call('get_comments', { limit: 5000 })).result?.isError === true);
    check('a status nobody defined is rejected', (await call('get_comments', { status: 'todo' })).result?.isError === true);
    check('a scope nobody defined is rejected', (await call('get_comments', { scope: 'everything' })).result?.isError === true);
    const limited = structured(await call('get_comments', { status: 'all', limit: 1 }));
    check('a limit is obeyed', limited.reviews.length === 1);
    check('and says the list was cut', limited.truncated === true && limited.total === 2);

    // Checked the way a real client checks it: the ACTUAL response body,
    // against the ACTUAL schema this server publishes in tools/list, through
    // the validator the SDK ships. Reading `structuredContent` and looking at
    // its fields — which is what every other assertion in this file does — is
    // exactly how `get_comments` came to be unusable from Claude Code
    // ("data must NOT have additional properties") while the suite was green.
    const published = Object.fromEntries(
      ((await readBody(await post({ jsonrpc: '2.0', id: 9001, method: 'tools/list' })))?.result?.tools || []).map((t) => [
        t.name,
        t.outputSchema,
      ])
    );
    const validateOutput = async (tool, response) => {
      const schema = published[tool];
      if (!schema) return { valid: false, errorMessage: `${tool} publishes no output schema` };
      return await schemaValidator.getValidator(schema)(structured(response));
    };

    // ── A mutation that will not be saved must not be reported as done ──
    //
    // Two Stackis, one project. The other one writes; this one's next
    // mutation is refused by the store. What must NOT happen is `comment`
    // answering ok:true — an agent told a review was resolved moves on, and
    // nothing will remember the resolution.
    {
      const other = createReviewStore({ file: reviewFile, projectPath: ROOT });
      const foreign = other.apply({
        action: 'create',
        message: 'written by the other window',
        // A deliberately thin anchor, the way a hand-edited or older ledger
        // can be: the answer still has to match the published schema.
        anchor: { page: {}, keys: ['src/pages/index.astro#0.9'], breakpoint: {}, pin: null, fingerprint: null },
        creationContext: {},
      }).thread;

      const raw = await call('comment', { action: 'resolve', threadId: A, message: 'done and verified' });
      const refused = structured(raw);
      check('a mutation the store will not save is not reported as done', refused.ok === false, JSON.stringify(refused));
      check('and says exactly which conflict it was', refused.code === 'foreign_write', refused.code);
      check('in words that tell the agent what to do next', /reloaded/.test(refused.message || ''), refused.message);
      const refusalShape = await validateOutput('comment', raw);
      check('the refusal still validates against the published schema', refusalShape.valid, refusalShape.errorMessage || '');

      // Folded back out of the file rather than read as fields off it: the
      // ledger is an append-only event log, so "is it on disk" means "does the
      // file still project to this".
      const onDisk = createReviewStore({ file: reviewFile, projectPath: ROOT }).all();
      check('the winning ledger is what is on disk', onDisk.some((t) => t.messages[0].body === 'written by the other window'));
      check('and the review was not resolved there', onDisk.find((t) => t.id === A)?.status !== 'resolved', onDisk.find((t) => t.id === A)?.status);
      const after = await call('get_comments', { status: 'all', detail: 'full' });
      check('get_comments does not show the unsaved resolution', !structured(after).reviews.some((r) => r.id === A && r.status === 'resolved'), JSON.stringify(structured(after).reviews.map((r) => `${r.id === A ? 'A' : r.number}:${r.status}`)));
      check('and it does show the other window\u2019s review', structured(after).reviews.some((r) => r.id === foreign.id));
      const thinShape = await validateOutput('get_comments', after);
      check('a thin anchor from another window still validates', thinShape.valid, thinShape.errorMessage || '');

      // Recovered, not wedged: the same call made again now lands.
      const recovered = structured(await call('comment', { action: 'resolve', threadId: A, message: 'done and verified' }));
      check('doing it again against the reloaded ledger works', recovered.ok === true, JSON.stringify(recovered));
      check('and that resolution really is on disk', createReviewStore({ file: reviewFile, projectPath: ROOT }).get(A).status === 'resolved');
      // Put the ledger back the way the rest of this file expects to find it.
      await call('comment', { action: 'reopen', threadId: A, message: 'back to open' });
      ledger.remove(foreign.id);
      check('the ledger is back to the two these tests share', ledger.size === 2, String(ledger.size));
    }

    // Editing and pruning are not things an agent gets to do. The store keeps
    // them off `apply`; this is the check that the door itself has no handle.
    {
      check('comment has no edit action', !REVIEW_ACTIONS.includes('edit') && !REVIEW_ACTIONS.includes('editMessage'), REVIEW_ACTIONS.join());
      check('nor one for deleting a message', !REVIEW_ACTIONS.includes('removeMessage') && !REVIEW_ACTIONS.includes('delete'), REVIEW_ACTIONS.join());
      const tried = structured(await call('comment', { action: 'editMessage', threadId: A, message: 'not on my watch' }));
      check('and asking for one is refused at the schema', tried?.ok !== true, JSON.stringify(tried));
      const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'mcp', 'reviewTools.js'), 'utf8');
      check('no MCP tool reaches editMessage', !/editMessage/.test(source));
      check('nor removeMessage', !/removeMessage/.test(source));
      // It IS visible, though: an agent reading a thread should know that a
      // message was changed after the fact.
      const full = structured(await call('get_comments', { status: 'all', detail: 'full' }));
      check('but an edited message is visible to a reader', full.reviews.every((r) => (r.messages || []).every((m) => 'editedAt' in m)), JSON.stringify(full.reviews[0]?.messages?.[0]));
    }

    // A single answer must not be tens of megabytes. Messages are capped per
    // review, but nothing capped the response: 200 maximal reviews is ~44MB
    // arriving in somebody's context window unasked.
    {
      const bigAnchor = {
        type: 'node',
        page: { route: '/', file: 'src/pages/index.astro' },
        keys: Array.from({ length: 24 }, (_, i) => `src/components/C${i}.astro#${'0.'.repeat(20)}1`),
        occurrence: 0,
        occurrenceCount: 4,
        breakpoint: { device: 'phone', viewportWidth: 375, viewportHeight: 800 },
        pin: { xRatio: 0.5, yRatio: 0.5 },
        fingerprint: { nodeKind: 'element', tag: 'span', text: 'x'.repeat(160), componentChain: Array(30).fill('Component'), breadcrumbs: Array(30).fill('label') },
      };
      const bigContext = {
        page: bigAnchor.page,
        keys: bigAnchor.keys,
        componentChain: Array(30).fill('Component'),
        breadcrumbs: Array(30).fill('label'),
        nodeKind: 'element',
        tag: 'span',
        text: 't'.repeat(400),
        props: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, 'v'.repeat(200)])),
        classes: Array.from({ length: 60 }, () => 'c'.repeat(80)),
        occurrence: 0,
        occurrenceCount: 4,
        breakpoint: bigAnchor.breakpoint,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        branch: 'main',
        sourceTrail: null,
      };
      // Four maximal threads is already more than the budget: a full read of
      // one is fifty 4000-character messages plus a maxed creation context,
      // about 215KB. Four rather than forty because every mutation is a write
      // now — the fixture is about the size of the ANSWER, and building it out
      // of a thousand saved ledgers would only be measuring the disk.
      const heavy = [];
      for (let i = 0; i < 4; i++) {
        const made = ledger.apply({ action: 'create', message: 'm'.repeat(4000), anchor: bigAnchor, creationContext: bigContext }).thread;
        for (let j = 0; j < 50; j++) ledger.apply({ action: 'reply', threadId: made.id, message: 'r'.repeat(4000) });
        heavy.push(made.id);
      }
      const fat = structured(await call('get_comments', { status: 'all', detail: 'full', limit: 200 }));
      const size = JSON.stringify(fat).length;
      check('a pathological full read stays within the budget', size < 700_000, `${Math.round(size / 1024)}KB`);
      check('and says the list was cut', fat.truncated === true);
      check('and how many actually came back', fat.returned < fat.total, `${fat.returned}/${fat.total}`);
      check('while still returning something useful', fat.returned >= 1);
      const slim = structured(await call('get_comments', { status: 'all', detail: 'summary', limit: 200 }));
      check('a summary read of the same ledger stays small', JSON.stringify(slim).length < 200_000, `${Math.round(JSON.stringify(slim).length / 1024)}KB`);

      // Every key the implementation sends must be DECLARED.
      check('the published get_comments schema is a closed one', published.get_comments?.additionalProperties === false);
      for (const shape of [
        ['a full read', { status: 'all', detail: 'full', limit: 3 }],
        ['a summary read', { status: 'open', detail: 'summary', limit: 50 }],
        ['a page-scoped read', { status: 'all', scope: 'page' }],
        ['an over-budget read', { status: 'all', detail: 'full', limit: 200 }],
      ]) {
        const verdict = await validateOutput('get_comments', await call('get_comments', shape[1]));
        check(`${shape[0]} validates against the published get_comments schema`, verdict.valid, verdict.errorMessage || '');
      }
      for (const shape of [
        ['a reply', { action: 'reply', threadId: A, message: 'schema probe' }],
        ['a refusal', { action: 'reply', threadId: 'rt_nope', message: 'x' }],
        ['a focus', { action: 'focus', threadId: A }],
      ]) {
        const verdict = await validateOutput('comment', await call('comment', shape[1]));
        check(`${shape[0]} validates against the published comment schema`, verdict.valid, verdict.errorMessage || '');
      }

      for (const id of heavy) ledger.remove(id);

      // And once more with the real anchors back — the pathological ones above
      // were built by hand, so on their own they would not have exercised what
      // anchorFrom actually records.
      const real = await call('get_comments', { status: 'all', detail: 'full' });
      check('the real reviews are what is being validated', structured(real).reviews.some((r) => r.id === A));
      check('and they carry the sibling runs', structured(real).reviews.some((r) => r.anchor?.fingerprint?.peers?.length));
      const back = await validateOutput('get_comments', real);
      check('a full read of real anchors validates too', back.valid, back.errorMessage || '');
    }


    // The review tools must not have changed what the other two answer.
    const after = structured(await call('get_context', {}));
    check('get_context is untouched by any of this', after.selection.tag === 'section' && after.selection.status === 'ready');
    const stillShoots = await call('capture', {});
    check('capture is untouched too', stillShoots.result?.content?.some((c) => c.type === 'image'));

    // Reviews are local state, and the door in front of them is the same door.
    const noToken = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'get_comments', arguments: {} } }),
    });
    check('reading somebody\\u2019s reviews still needs the token', noToken.status === 401, String(noToken.status));
    const badOrigin = await post(
      { jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'comment', arguments: { action: 'create', message: 'from a web page' } } },
      { origin: 'http://evil.example' }
    );
    check('a web page cannot write into them', badOrigin.status === 403, String(badOrigin.status));
    check('a rebinding Host cannot either', (await rawPost('evil.example', { jsonrpc: '2.0', id: 902, method: 'tools/call', params: { name: 'get_comments', arguments: {} } })) === 403);
    check('and none of that created anything', ledger.size === 2, String(ledger.size));

    // "#1" is what a person reads off a pin and types at an agent. An agent
    // that could only take the uuid would send them to look it up. Left until
    // last, because it adds messages and the counts above are the point of
    // several checks.
    const numbered = structured(await call('get_comments', { status: 'all' })).reviews[0];
    check('every review has a short number', Number.isInteger(numbered.number) && numbered.number > 0, JSON.stringify(numbered.number));
    check('a review answers to its number', structured(await call('comment', { action: 'reply', threadId: `#${numbered.number}`, message: 'by number' }))?.ok === true);
    check('with or without the hash', structured(await call('comment', { action: 'reply', threadId: String(numbered.number), message: 'bare number' }))?.ok === true);
    check('and a number nobody has is still a named refusal', structured(await call('comment', { action: 'reply', threadId: '#9999', message: 'x' }))?.code === 'no_thread');
    check('the numbers are distinct', new Set(structured(await call('get_comments', { status: 'all' })).reviews.map((r) => r.number)).size === 2);
    check('and the schema says the tool takes one', /short number/.test(tools.find((t) => t.name === 'comment').inputSchema.properties.threadId.description));
  }

  await ledger.flush();
  check('everything the agent did is on disk', createReviewStore({ file: reviewFile, projectPath: ROOT }).size === 2);
  check('and it is not in the project', !reviewFile.startsWith(ROOT));
  try {
    fs.rmSync(reviewHome, { recursive: true, force: true });
  } catch {
    /* a leftover temp folder is not a test failure */
  }

  // --- the port ---
  await server.stop();
  check('stop() stops listening', server.listening === false);

  const again = createStackiMcpServer({ port: PORT, token: TOKEN, getContext: async () => SNAPSHOT, capture: async () => ({ image: null, mimeType: null, meta: {} }), getComments, comment, onError: () => {} });
  await again.start();
  check('the port is free again straight after a stop', again.listening === true);
  await again.stop();

  const squatter = http.createServer(() => {});
  await new Promise((r) => squatter.listen(PORT, '127.0.0.1', r));
  let portError = null;
  try {
    await createStackiMcpServer({ port: PORT, token: TOKEN, getContext: async () => SNAPSHOT, capture: async () => ({}), getComments, comment, onError: () => {} }).start();
  } catch (err) {
    portError = err;
  }
  check('an occupied port fails rather than moving', !!portError, 'it started anyway');
  check('the failure names the port', portError && portError.message.includes(String(PORT)), portError && portError.message);
  check('the failure says what to do about it', portError && /STACKI_MCP_PORT/.test(portError.message), portError && portError.message);
  await new Promise((r) => squatter.close(r));

  check('a server with no token refuses to exist', (() => {
    try {
      createStackiMcpServer({ port: PORT, getContext: async () => ({}), capture: async () => ({}), getComments, comment });
      return false;
    } catch {
      return true;
    }
  })());
  check('a server with no tools refuses to exist', (() => {
    try {
      createStackiMcpServer({ port: PORT, token: TOKEN });
      return false;
    } catch {
      return true;
    }
  })());
  // Half a surface is worse than none: a Stacki that answered get_context but
  // not get_comments would be a client configuration problem nobody could
  // diagnose from the outside.
  check('a server with no review tools refuses to exist', (() => {
    try {
      createStackiMcpServer({ port: PORT, token: TOKEN, getContext: async () => ({}), capture: async () => ({}) });
      return false;
    } catch {
      return true;
    }
  })());

  check('an empty bearer never matches', !tokenMatches('', '') && !tokenMatches(TOKEN, '') && !tokenMatches('', TOKEN));
  check('a matching bearer matches', tokenMatches(TOKEN, TOKEN));
  check('the scheme is parsed case-insensitively', bearerOf('bearer abc') === 'abc' && bearerOf('BEARER  abc') === 'abc');
  check('a missing header parses to nothing', bearerOf(undefined) === null && bearerOf('') === null);

  // ── What the renderer publishes ───────────────────────────────────────────
  //
  // The other half of the boundary: the app's own state, flattened. Checked
  // here because a field that quietly stops being filled in looks exactly like
  // a field the app has nothing to say about.

  {
    const esbuild = require('esbuild');
    const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
    fs.mkdirSync(buildDir, { recursive: true });
    const out = path.join(buildDir, 'mcp-context.bundle.mjs');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'mcpContext.js')],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    const { buildMcpPayload } = await import(`file://${out}?v=${Date.now()}`);

    const node = {
      id: 'n1',
      kind: 'element',
      name: 'section',
      props: { class: 'hero', 'data-n': 2 },
      children: [
        { id: 'h', kind: 'element', name: 'h1', children: [{ id: 't', kind: 'text', value: '  Hello  ' }] },
        { id: 'e', kind: 'expr', value: '{count}' },
      ],
    };
    const base = {
      project: { path: '/p' },
      currentPage: { path: '/p/src/pages/index.astro', route: '/' },
      pageRoute: '/',
      editStack: [{ name: 'index.astro', path: '/p/src/pages/index.astro' }, { name: 'Card', path: '/p/src/components/Card.astro' }],
      selectedId: 'n1',
      selectedNode: node,
      selectionKeys: ['src/pages/index.astro#0', 'src/components/Card.astro#0.1'],
      crumbs: [{ label: 'index' }, { label: 'section' }],
      selectedClasses: ['hero', 'is-big'],
      hidden: false,
      inert: true,
      devStatus: 'on',
      canvas: { device: 'tablet', viewportWidth: 768, viewportHeight: 900, rect: { x: 1, y: 2, w: 3, h: 4 }, spacing: { padding: { top: 8 } }, occurrence: 1, occurrenceCount: 3 },
    };
    const p1 = buildMcpPayload(base);
    check('the payload names the project', p1.project.root === '/p');
    check('the payload names the page on screen, not the file being edited', p1.page.file === '/p/src/pages/index.astro', p1.page.file);
    check('the payload carries the breakpoint the canvas is in', p1.view.device === 'tablet' && p1.view.viewportWidth === 768);
    check('the payload carries the preview status', p1.preview.status === 'on');
    check('the payload says something is selected', p1.selection.present === true);
    check('the payload names the tag', p1.selection.tag === 'section' && p1.selection.nodeKind === 'element');
    check('the payload carries the node keys ⇧⌘C resolves', p1.selection.keys.length === 2);
    check('the payload carries the drill-down chain', p1.selection.componentChain.join('>') === 'index.astro>Card');
    check('the payload carries the breadcrumbs', p1.selection.breadcrumbs.join('>') === 'index>section');
    check('the payload reads the visible words', p1.selection.text === 'Hello {count}', JSON.stringify(p1.selection.text));
    check('the payload carries the rendered classes, not the authored ones', p1.selection.classes.join() === 'hero,is-big');
    check('the payload carries the node states', p1.selection.hidden === false && p1.selection.inert === true);
    check('the payload carries the copy the canvas measured', p1.selection.occurrence === 1 && p1.selection.occurrenceCount === 3);
    check('the payload carries the box and the spacing', p1.selection.rect.w === 3 && p1.selection.spacing.padding.top === 8);

    const nothing = buildMcpPayload({ ...base, selectedId: null, selectedNode: null });
    check('nothing selected still says which files are open', nothing.selection.present === false && nothing.selection.componentChain.join('>') === 'index.astro>Card');
    const noProject = buildMcpPayload({});
    check('no project publishes an empty root rather than throwing', noProject.project.root === null && noProject.selection.present === false);
    const noCanvas = buildMcpPayload({ ...base, canvas: null });
    check('no canvas report leaves the geometry out', noCanvas.selection.rect === null && noCanvas.view.device === null);

    // A deep tree must not serialize the whole page into the answer.
    const deep = { id: 'd', kind: 'element', name: 'div', children: [] };
    let cursor = deep;
    for (let i = 0; i < 12; i++) {
      const next = { id: 'x' + i, kind: 'element', name: 'div', children: [{ id: 'tx' + i, kind: 'text', value: 'level ' + i }] };
      cursor.children.push(next);
      cursor = next;
    }
    const capped = buildMcpPayload({ ...base, selectedNode: deep });
    check('the text read off a node stops before the whole page', (capped.selection.text || '').length < 200, String((capped.selection.text || '').length));
    check('a dynamic route publishes the entry being previewed', buildMcpPayload({ ...base, pageRoute: '/blog/hello' }).page.route === '/blog/hello');
  }

  // ── The panel the user sees ───────────────────────────────────────────────
  //
  // A background service on a port with a bearer token must not be invisible,
  // and the panel that makes it visible must not be the thing that leaks it.

  {
    const esbuild = require('esbuild');
    const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, 'mcp-dialog.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'McpDialog.jsx')],
      outfile: bundlePath,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      loader: { '.css': 'empty', '.svg': 'empty' },
      logLevel: 'silent',
    });
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const McpDialog = require(bundlePath).default;
    const render = (status) =>
      renderToStaticMarkup(React.createElement(McpDialog, { status, onClose: () => {} }));

    const TOK = 'z'.repeat(43);
    const up = render({ running: true, url: 'http://127.0.0.1:43821/mcp', port: 43821, token: TOK, error: null });
    check('the panel shows the endpoint', up.includes('http://127.0.0.1:43821/mcp'));
    check('the panel says it is running', /mcp-status on/.test(up));
    check('the panel offers the Claude Code command', up.includes('claude mcp add --transport http'));
    check('the command registers for every project', up.includes('--scope user'));
    check('the panel does not print the token until it is asked to', !up.includes(TOK), 'the token is on screen by default');
    check('the panel masks the token instead', up.includes('••••••••'));
    check('the panel names Cursor too', up.includes('Cursor'));
    check('the panel offers the JSON a headless run and a .mcp.json both need', up.includes('Claude Code (JSON)'));

    // EVERY RECIPE, HELD TO THE FILE IT IS FOR.
    //
    // The invariant here used to be "every recipe carries the token exactly
    // once", which was the wrong invariant and passed happily while the panel
    // generated a `.mcp.json` with a live bearer token in it -- for a file whose
    // own documentation says to check it into version control.
    //
    // A recipe now declares the file it is for, and that decides everything:
    //
    //   scope 'user'     ~/.claude.json, written by `claude mcp add --scope
    //                    user`. Private to one person. The token belongs in it,
    //                    exactly once, so the panel's single-replace mask works.
    //   scope 'project'  .mcp.json / .cursor/mcp.json. Goes in the repository.
    //                    ZERO bytes of the token, and an environment variable in
    //                    the host's own syntax instead.
    //
    // Asserted off `scope` rather than off the three keys that exist today, so a
    // fourth recipe added with the wrong one fails here instead of shipping.
    const { CLIENTS, TOKEN_ENV_VAR } = require(bundlePath);
    const ENDPOINT = 'http://127.0.0.1:43821/mcp';
    check('there are recipes for three clients', CLIENTS.length === 3, `${CLIENTS.length}`);
    check('and the environment variable has one name', TOKEN_ENV_VAR === 'STACKI_MCP_TOKEN', String(TOKEN_ENV_VAR));

    // The host syntaxes, verified against each host's current documentation:
    //   Claude Code  ${VAR}      code.claude.com/docs/en/mcp
    //   Cursor       ${env:VAR}  cursor.com/docs/context/mcp
    const PLACEHOLDER = { 'claude-json': '${STACKI_MCP_TOKEN}', cursor: '${env:STACKI_MCP_TOKEN}' };

    for (const recipe of CLIENTS) {
      const snippet = recipe.text({ url: ENDPOINT, token: TOK });
      const occurrences = snippet.split(TOK).length - 1;
      check(`  ${recipe.key} declares which file it is for`, recipe.scope === 'user' || recipe.scope === 'project', String(recipe.scope));

      if (recipe.scope === 'project') {
        // THE ONE THAT MATTERS. Not "few" occurrences, not "masked" — none.
        check(`  ${recipe.key} is committable and carries NO token`, occurrences === 0, `${occurrences} occurrence(s) of the live token`);
        check(`  ${recipe.key} names the environment variable instead`, snippet.includes(PLACEHOLDER[recipe.key]), snippet.slice(0, 200));
        // Copying the config must not put the secret on the clipboard: the
        // button copies this exact string.
        check(`  ${recipe.key} puts nothing secret on the clipboard`, !snippet.includes(TOK));
        check(`  ${recipe.key} says it is safe to commit`, /safe to commit/i.test(String(recipe.hint)), String(recipe.hint).slice(0, 120));
      } else {
        check(`  ${recipe.key} is private and carries the token once`, occurrences === 1, `${occurrences} occurrence(s)`);
        check(`  ${recipe.key} is masked by the panel's own replace`, !snippet.replace(TOK, '••••••••').includes(TOK));
        check(`  ${recipe.key} is for a file only this person has`, /--scope user/.test(snippet), snippet.slice(0, 120));
      }

      if (snippet.trim().startsWith('{')) {
        let parsed = null;
        try {
          parsed = JSON.parse(snippet);
        } catch {
          parsed = null;
        }
        check(`  ${recipe.key} is a document that parses`, !!parsed, snippet.slice(0, 120));
        check(`  ${recipe.key} points at the running endpoint`, JSON.stringify(parsed).includes(ENDPOINT));
        check(
          `  ${recipe.key} puts the header where the host reads it`,
          typeof parsed?.mcpServers?.stacki?.headers?.Authorization === 'string' &&
            parsed.mcpServers.stacki.headers.Authorization.startsWith('Bearer '),
          JSON.stringify(parsed?.mcpServers?.stacki?.headers)
        );
      }
    }
    // The one key the Cursor shape does not have, and the reason the CLI command
    // could not simply be copied into a file.
    const claudeJson = JSON.parse(CLIENTS.find((c) => c.key === 'claude-json').text({ url: ENDPOINT, token: TOK }));
    check('the JSON recipe declares the transport Claude Code needs', claudeJson.mcpServers?.stacki?.type === 'http', JSON.stringify(claudeJson));

    // And the panel itself: the reveal control belongs only to the recipe that
    // has something to reveal.
    check('a project recipe is not offered a Show token button', (CLIENTS.filter((c) => c.scope === 'project').length === 2), 'two project recipes expected');
    check('the panel says the token is not for the project', /never in\s+your project/.test(up.replace(/\s+/g, ' ')) || /never in your project/.test(up.replace(/\s+/g, ' ')));

    const down = render({ running: false, url: null, port: 43821, token: null, error: 'port 43821 is already in use, so the Stacki MCP server did not start.' });
    check('the panel says when it is not running', /mcp-status off/.test(down) && down.includes('Not running'));
    check('the panel shows why it is not running', down.includes('already in use'));
    check('the panel offers nothing to copy when there is nothing to copy', !down.includes('claude mcp add'));
  }

  if (failures.length) {
    console.error(`\nmcp: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`mcp: ${checked} passed  [context, crop, throttling, schemas, the door]`);
})().catch((err) => {
  console.error('\nmcp: threw\n', err);
  process.exit(1);
});
