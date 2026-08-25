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
const { createStackiMcpServer, tokenMatches, bearerOf, DEFAULT_PORT, ENDPOINT_PATH } = require('../electron/mcp/server.js');
const { ContextOutput, CaptureOutput, INSTRUCTIONS } = require('../electron/mcp/tools.js');
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
  const dir = path.join(__dirname, '..', 'electron', 'mcp');
  const needsElectron = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .filter((n) => /require\(\s*'electron'\s*\)/.test(fs.readFileSync(path.join(dir, n), 'utf8')));
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
  check('the server says the tools are read-only', /read-only/i.test(INSTRUCTIONS));
  check('the server says not to start another dev server', /do not start another dev server/i.test(INSTRUCTIONS));
  check('the instructions stay short enough to be read', INSTRUCTIONS.length < 900, `${INSTRUCTIONS.length} chars`);
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

  let captured = null;
  const server = createStackiMcpServer({
    port: PORT,
    token: TOKEN,
    version: '1.2.3',
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
  check('exactly two tools are exposed', tools.length === 2, tools.map((t) => t.name).join(','));
  check('they are get_context and capture', tools.map((t) => t.name).sort().join(',') === 'capture,get_context');
  check('nothing here can edit source', !tools.some((t) => /set_|write|edit|modify|move|change/i.test(t.name)));
  for (const tool of tools) {
    const a = tool.annotations || {};
    check(`${tool.name} is annotated read-only`, a.readOnlyHint === true && a.destructiveHint === false && a.idempotentHint === true && a.openWorldHint === false, JSON.stringify(a));
    check(`${tool.name} declares an input schema`, tool.inputSchema?.type === 'object');
    check(`${tool.name} declares an output schema`, tool.outputSchema?.type === 'object');
    check(`${tool.name} has a description`, typeof tool.description === 'string' && tool.description.length > 40);
  }
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
  check('the rejection says what was wrong', /validation/i.test(badDetail.result?.content?.[0]?.text || ''), badDetail.result?.content?.[0]?.text);

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

  // --- the port ---
  await server.stop();
  check('stop() stops listening', server.listening === false);

  const again = createStackiMcpServer({ port: PORT, token: TOKEN, getContext: async () => SNAPSHOT, capture: async () => ({ image: null, mimeType: null, meta: {} }), onError: () => {} });
  await again.start();
  check('the port is free again straight after a stop', again.listening === true);
  await again.stop();

  const squatter = http.createServer(() => {});
  await new Promise((r) => squatter.listen(PORT, '127.0.0.1', r));
  let portError = null;
  try {
    await createStackiMcpServer({ port: PORT, token: TOKEN, getContext: async () => SNAPSHOT, capture: async () => ({}), onError: () => {} }).start();
  } catch (err) {
    portError = err;
  }
  check('an occupied port fails rather than moving', !!portError, 'it started anyway');
  check('the failure names the port', portError && portError.message.includes(String(PORT)), portError && portError.message);
  check('the failure says what to do about it', portError && /STACKI_MCP_PORT/.test(portError.message), portError && portError.message);
  await new Promise((r) => squatter.close(r));

  check('a server with no token refuses to exist', (() => {
    try {
      createStackiMcpServer({ port: PORT, getContext: async () => ({}), capture: async () => ({}) });
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
