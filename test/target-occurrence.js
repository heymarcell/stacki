// What "rendered N times" is allowed to mean.
//
//   node test/target-occurrence.js
//
// `target read` warns that a node is one source node rendered several times,
// and that editing it reaches every copy. It is the most consequential sentence
// in the answer: an agent that believes it stops editing the node and goes
// looking for the data item behind it instead.
//
// It fired on a <p> beside an <h3> in a plain `header.section-header`, with no
// `.map()` anywhere above it. The sentence was faithful to the number it was
// given; the number was not a count of renders.
//
// It never was. `occurrenceCount` is produced in exactly two places —
// electron/preload.js (a click: `boxes.length`) and src/panels/PreviewPane.jsx
// (the canvas report: `selRects.length`) — and both count what `rectsForPath`
// measured: one entry per marker RUN, or, when no marker pair survived the
// compile, one per outermost tagged element. A single rendering measures as
// several places whenever it puts several elements on the page under one name:
// a component with two root elements (both roots carry the caller's name for
// the instance), a paragraph a line-splitter rebuilt as one clone per line.
// Part one below measures all of that through the real preload, and the false
// cases and the true one come out as the same number, 2 — so nothing
// downstream can tell them apart by looking at it.
//
// The source can tell them apart, and always could: a node is rendered once
// per item exactly when a `map` is above it. Part two holds the answer to that.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const short = (v) => JSON.stringify(v);

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'electron', 'preload.js');

// --- part one: what the canvas is counting -----------------------------------
//
// The real preload, over a DOM holding the shapes side by side. Boxes are
// stubbed per class so "which element" is a question the numbers answer; the
// counting itself is the shipped code.
async function measured() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    `<!doctype html><body class="page"><main class="main">
      <!-- ONE render: plain page markup, marker pair and attribute both intact -->
      <!--avb-s:0.0-->
      <header class="a-hdr" data-avb-p="0.0">
        <!--avb-s:0.0.0--><h3 class="a-h3" data-avb-p="0.0.0">Title</h3><!--avb-e:0.0.0-->
        <!--avb-s:0.0.1--><p class="a-p" data-avb-p="0.0.1">Body</p><!--avb-e:0.0.1-->
      </header>
      <!--avb-e:0.0-->

      <!-- ONE render: a component with two ROOT elements, slotted, so the
           marker pair around the instance could not be written and the two
           roots are all that carry the page's name for it. -->
      <h3 class="c-h3" data-avb-p="Card.astro|0 0.2">Title</h3>
      <p class="c-p" data-avb-p="Card.astro|1 0.2">Body</p>

      <!-- ONE render: a line splitter rebuilt one paragraph as a clone per
           line, and attributes ride along on clones. -->
      <p class="d-1" data-avb-p="0.3">line one</p>
      <p class="d-2" data-avb-p="0.3">line two</p>

      <!-- TWO renders: a genuine .map() over two items. -->
      <!--avb-s:0.4.0--><li class="e-1" data-avb-p="0.4.0">a</li><!--avb-e:0.4.0-->
      <!--avb-s:0.4.0--><li class="e-2" data-avb-p="0.4.0">b</li><!--avb-e:0.4.0-->
    </main></body>`,
    { url: 'http://localhost:4321/#avb-design', pretendToBeVisual: true }
  );
  const { window } = dom;
  const BOXES = {
    'a-hdr': [0, 0, 400, 100], 'a-h3': [0, 0, 400, 40], 'a-p': [0, 40, 400, 60],
    'c-h3': [0, 200, 400, 40], 'c-p': [0, 240, 400, 60],
    'd-1': [0, 300, 400, 20], 'd-2': [0, 320, 400, 20],
    'e-1': [0, 400, 400, 30], 'e-2': [0, 430, 400, 30],
    main: [0, 0, 400, 900], page: [0, 0, 400, 900],
  };
  const NO_BOX = { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };
  window.Element.prototype.getBoundingClientRect = function () {
    const b = BOXES[(this.getAttribute('class') || '').split(' ')[0]];
    if (!b) return NO_BOX;
    const [x, y, w, h] = b;
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
  };
  window.Range.prototype.getBoundingClientRect = () => NO_BOX;
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.navigator = window.navigator;
  global.MutationObserver = window.MutationObserver;
  global.Element = window.Element;
  global.Node = window.Node;
  global.MouseEvent = window.MouseEvent;
  global.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  const sent = [];
  window.parent = { postMessage: (m) => sent.push(m) };
  const electron = {
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { on: () => {}, send: () => {}, invoke: async () => {} },
    webUtils: {},
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    return id === 'electron' ? electron : realRequire.apply(this, arguments);
  };
  process.isMainFrame = false;
  require(PRELOAD);
  Module.prototype.require = realRequire;
  await new Promise((r) => setTimeout(r, 60));

  // The same message the app sends to ask for boxes, and the same reply
  // PreviewPane counts to fill `occurrenceCount`.
  return (p) => {
    const ev = new window.MessageEvent('message', {
      data: { type: 'avb:track', paths: [p], scope: '', focus: '', focusOcc: 0 },
    });
    Object.defineProperty(ev, 'source', { value: window.parent });
    window.dispatchEvent(ev);
    const reply = sent.filter((m) => m.type === 'avb:rects').pop();
    return ((reply?.rects || {})[p] || []).length;
  };
}

// --- part two: the answer ------------------------------------------------------

const PAGE = `---
import Card from '../components/Card.astro';
const plans = [
  { title: 'Starter', body: 'For one person' },
  { title: 'Team', body: 'For a few people' },
];
---
<section class="section">
  <header class="section-header">
    <h3>Plans</h3>
    <p class="section-header_text">Pick one.</p>
  </header>
  <div class="grid">
    {plans.map((plan) => (
      <Card title={plan.title} body={plan.body} />
    ))}
  </div>
</section>
`;

(async () => {
  const boxesFor = await measured();

  // A single rendering, measured as one place: the control that says the
  // counter is not simply broken everywhere.
  check('plain markup rendered once measures one box', boxesFor('0.0.1') === 1, String(boxesFor('0.0.1')));
  // …and the two shapes where one rendering measures as several places.
  check(
    'a two-root component placed once measures TWO boxes',
    boxesFor('0.2') === 2,
    String(boxesFor('0.2'))
  );
  check(
    'a split paragraph rendered once measures TWO boxes',
    boxesFor('0.3') === 2,
    String(boxesFor('0.3'))
  );
  // …against a genuine repeat, which measures the same number. This is the
  // whole finding in one line: the count cannot distinguish them.
  check(
    'and a real two-item loop measures TWO boxes as well',
    boxesFor('0.4.0') === 2,
    String(boxesFor('0.4.0'))
  );

  // The real parser, the real command surface, the real readTarget.
  const { parsePage } = require(path.join(ROOT, 'electron', 'astroParser.js'));
  const esbuild = require('esbuild');
  const buildDir = path.join(ROOT, 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const out = path.join(buildDir, 'target-occurrence.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'agent', 'commands.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    // Dependencies stay where they are: the style half of the command surface
    // pulls in postcss, which reaches for node built-ins through a dynamic
    // require that a bundle cannot answer. Nothing here is about styles.
    packages: 'external',
    logLevel: 'silent',
  });
  const { createAgentCommands } = await import(`file://${out}?v=${Date.now()}`);

  const parsed = parsePage(PAGE);
  check('the fixture page parses', parsed.editable === true, short(parsed.reason || null));
  const model = parsed.model;

  // Walking by index path rather than by name: this is the tree the app holds.
  const at = (trail) => {
    let list = model.nodes;
    let node = null;
    for (const i of trail) {
      node = list[i];
      list = node?.children || [];
    }
    return node;
  };
  const header = at([0, 0]);
  const beside = at([0, 0, 1]); // the <p> next to the <h3>
  const loop = at([0, 1, 0]);
  const card = at([0, 1, 0, 0]);
  check('the fixture has the header', header?.props?.class?.value === 'section-header', short(header?.name));
  check('and the <p> beside the <h3>', beside?.name === 'p', short(beside?.name));
  check('and a real loop', loop?.kind === 'map', short(loop?.kind));
  check('with a card inside it', card?.name === 'Card', short(card?.name));

  // The app bundle commands.js reads, cut to what a read needs. `canvas` is
  // handed out only for the selected node — src/agent/commands.js — which is
  // exactly the path the false warning came down.
  const appFor = (selected, canvas) => ({
    project: () => ({ path: '/tmp/fixture' }),
    page: () => ({ file: 'src/pages/index.astro', route: '/' }),
    openFile: () => 'src/pages/index.astro',
    editable: () => true,
    selectedId: () => selected.id,
    revision: () => 1,
    digest: () => 'digest',
    crumbLabel: (n) => n?.name || n?.kind || null,
    crumbsFor: () => [],
    keysFor: () => ['src/pages/index.astro#0.0.1'],
    peersFor: () => null,
    pathFor: () => null,
    canvas: () => canvas,
    renderedClasses: () => null,
    componentChain: () => [],
    isHidden: () => false,
    isInert: () => false,
    model: () => model,
  });
  const readOf = async (node, canvas) => {
    const run = createAgentCommands(() => appFor(node, canvas));
    const answer = await run({ domain: 'target', action: 'read' });
    check(`the read of <${node.name || node.kind}> answers`, answer.ok === true, short(answer));
    return answer.target?.occurrence || null;
  };

  // --- the defect ------------------------------------------------------------
  //
  // One rendering that measured two places. Nothing in the source repeats it,
  // so nothing in the answer may say it is repeated.
  {
    const occ = await readOf(beside, { occurrence: 1, occurrenceCount: 2, rect: null });
    check('a node with no loop above it is not repeated', occ?.repeated === false, short(occ));
    check('its scope is single', occ?.scope === 'single', short(occ?.scope));
    check(
      'and nothing claims it is rendered twice',
      occ?.note == null,
      short(occ?.note)
    );
  }
  // The same node with the canvas measuring five places — a heavily split
  // paragraph — still says nothing. The count is not a threshold to clear.
  {
    const occ = await readOf(beside, { occurrence: 0, occurrenceCount: 5, rect: null });
    check('however many places it measured', occ?.repeated === false, short(occ));
    check('and still no note', occ?.note == null, short(occ?.note));
  }

  // --- what must keep working --------------------------------------------------
  //
  // A real `.map()`. If the warning were silenced globally rather than fixed,
  // every one of these would fail.
  {
    const occ = await readOf(card, { occurrence: 2, occurrenceCount: 3, rect: null });
    check('a node inside a loop is repeated', occ?.repeated === true, short(occ));
    check('its scope is shared_template', occ?.scope === 'shared_template', short(occ?.scope));
    check('the note says how many copies', /rendered 3 times/.test(occ?.note || ''), short(occ?.note));
    check('and that editing reaches all of them', /changes every copy/.test(occ?.note || ''), short(occ?.note));
    check('and points at the data item behind one', occ?.perOccurrence?.kind === 'loop_item', short(occ?.perOccurrence));
    check('which copy is in hand is still reported', occ?.index === 2, short(occ?.index));
    check('and how many places were measured', occ?.count === 3, short(occ?.count));
  }
  // The same loop child with NO canvas at all — no preview running. The warning
  // is a fact about the source, so it does not wait for a measurement.
  {
    const occ = await readOf(card, null);
    check('a loop child warns without a canvas', occ?.repeated === true, short(occ));
    check('and says so in words rather than a number', /changes every copy/.test(occ?.note || ''), short(occ?.note));
    check('with no invented count', !/rendered \d+ times/.test(occ?.note || ''), short(occ?.note));
  }
  // A one-item list measured once: still a template, and the sentence must not
  // read "rendered 1 times".
  {
    const occ = await readOf(card, { occurrence: 0, occurrenceCount: 1, rect: null });
    check('a loop rendering one item is still a shared template', occ?.scope === 'shared_template', short(occ?.scope));
    check('and is not described as rendered 1 times', !/rendered 1 times/.test(occ?.note || ''), short(occ?.note));
  }
  // The `.map()` node itself keeps its own answer.
  {
    const occ = await readOf(loop, { occurrence: null, occurrenceCount: 2, rect: null });
    check('the loop itself reports scope loop', occ?.scope === 'loop', short(occ?.scope));
    check('and says its children are the template', /not one of the things it renders/.test(occ?.note || ''), short(occ?.note));
  }

  if (failures.length) {
    console.error(`target-occurrence: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`target-occurrence: ${checked} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error('target-occurrence: threw\n', e);
  process.exit(1);
});
