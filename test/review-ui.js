// Leaving a comment, and reading one.
//
//   node test/review-ui.js
//
// The domain and the anchor are checked next door. This is the part a person
// actually touches, and three things about it fail in ways nobody sees:
//
//   The mode. Comment mode changes what a click means. A click that quietly
//   went on selecting instead, or a comment mode that never let go, are both
//   one-line mistakes that look fine until somebody is halfway through a
//   review.
//
//   The pins. They are drawn in the editor's overlay layer, and the one thing
//   they must never do is end up in a screenshot — the whole point of `capture`
//   is a picture of the site rather than a picture of Stacki. So this drives
//   the real capture probe on the real PreviewPane and checks the markers are
//   gone from the DOM while it is running.
//
//   The panel. Filters, an orphan that still reads properly, and the four
//   things that can be done to a thread going to the one implementation the
//   MCP tool goes to.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // One bundle, so the components and the modules they import are the same
  // instances the app uses — a second copy of mcpCanvas would register its
  // probe somewhere nothing could reach.
  const entry = path.join(buildDir, 'review-ui.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { default as CommentsPanel } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'CommentsPanel.jsx'))};
export { default as ReviewPins, ReviewSurface } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'ReviewPins.jsx'))};
export { placePins } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'reviewPins.js'))};
export { default as ReviewThread } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'ReviewThread.jsx'))};
export { default as PreviewPane } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'))};
export { ConfirmHost } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'ConfirmDialog.jsx'))};
export { beginCapture, endCapture } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'mcpCanvas.js'))};
`,
    'utf8'
  );
  const bundlePath = path.join(buildDir, 'review-ui.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.MutationObserver = dom.window.MutationObserver;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const noop = async () => null;
  const bridge = new Proxy(
    { openExternal: noop },
    {
      get: (t, k) => (k in t ? t[k] : typeof k === 'string' && k.startsWith('on') ? () => () => {} : noop),
    }
  );
  dom.window.avb = bridge;
  global.avb = bridge;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const act = React.act;
  // React only runs effects synchronously inside act() when it is told it is
  // in a test environment; without this every assertion below would be racing
  // an effect that had not run yet.
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.IS_REACT_ACT_ENVIRONMENT = true;
  const ui = require(bundlePath);

  const container = document.getElementById('root');
  const root = createRoot(container);
  const render = async (el) => {
    await act(async () => {
      root.render(el);
    });
  };
  const $ = (sel) => container.querySelector(sel);
  const $$ = (sel) => [...container.querySelectorAll(sel)];
  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  const type = async (el, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  // A review as the panel receives it: the full shape the service returns.
  const review = (over = {}) => ({
    id: 'rt_1',
    status: 'open',
    anchorState: 'attached',
    message: 'The pill is too tight on mobile.',
    replies: 0,
    lastAuthor: 'human',
    page: '/',
    breakpoint: 'phone',
    source: 'src/components/HeroSection.astro',
    occurrence: 1,
    occurrenceCount: 4,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    messages: [{ id: 'rm_1', authorType: 'human', body: 'The pill is too tight on mobile.', createdAt: Date.now() }],
    deferredReason: null,
    externalRefs: [],
    anchor: {
      page: { route: '/', file: 'src/pages/index.astro' },
      keys: ['src/pages/index.astro#0.3', 'src/components/HeroSection.astro#0.1.2'],
      breakpoint: { device: 'phone', viewportWidth: 375, viewportHeight: 800 },
      pin: { xRatio: 0.25, yRatio: 0.5 },
      fingerprint: { nodeKind: 'element', tag: 'span', text: 'Learn more', componentChain: null, breadcrumbs: null },
      sourceTrail: null,
    },
    creationContext: {
      tag: 'span',
      nodeKind: 'element',
      text: 'Learn more',
      componentChain: ['index', 'HeroSection'],
      breadcrumbs: ['index', 'section', 'span'],
    },
    ...over,
  });

  // ── The panel ─────────────────────────────────────────────────────────────

  {
    const acted = [];
    const opened = [];
    const rows = [
      review({ id: 'rt_open', status: 'open', message: 'Open one' }),
      review({ id: 'rt_def', status: 'deferred', message: 'Deferred one', deferredReason: 'Needs a decision.' }),
      review({ id: 'rt_res', status: 'resolved', message: 'Resolved one' }),
    ];
    let status = 'open';
    let scope = 'project';
    const panel = () =>
      React.createElement(ui.CommentsPanel, {
        reviews: rows.filter((r) => (status === 'all' ? true : r.status === status)),
        status,
        onStatus: (s) => {
          status = s;
        },
        scope,
        onScope: (s) => {
          scope = s;
        },
        openId: null,
        onOpen: (id) => opened.push(id),
        onAct: (...a) => acted.push(a),
        onFocus: () => acted.push(['focus']),
        onDelete: () => acted.push(['delete']),
        pinsVisible: true,
        commenting: false,
        onTogglePins: () => acted.push(['pins']),
        onToggleComment: () => acted.push(['mode']),
      });

    await render(panel());
    check('the panel is called Comments where a person can see it', /Comments/.test($('.panel-header h2')?.textContent || ''));
    check('it shows the open ones by default', $$('.comments-row').length === 1, String($$('.comments-row').length));
    check('a row shows the comment', /Open one/.test($('.comments-row')?.textContent || ''));
    check('a row says where it is', /src\/pages|\//.test($('.review-where')?.textContent || ''), $('.review-where')?.textContent);
    check('a row says the breakpoint it was written at', /phone/.test($('.comments-row')?.textContent || ''));
    check('and which copy of a repeated node', /copy 2\/4/.test($('.comments-row')?.textContent || ''), $('.comments-row')?.textContent);

    const tabs = $$('.comments-filters .seg')[0].querySelectorAll('button');
    check('there are exactly four status filters', tabs.length === 4, String(tabs.length));
    check('and they are the ones in the model, plus all', [...tabs].map((b) => b.textContent).join() === 'Open,Deferred,Resolved,All');
    await click(tabs[1]);
    status = 'deferred';
    await render(panel());
    check('deferred filters to deferred', $$('.comments-row').length === 1 && /Deferred one/.test($('.comments-row').textContent));
    status = 'resolved';
    await render(panel());
    check('resolved filters to resolved', /Resolved one/.test($('.comments-row').textContent));
    status = 'all';
    await render(panel());
    check('all shows all three', $$('.comments-row').length === 3);

    const scopes = $$('.comments-filters .seg')[1].querySelectorAll('button');
    check('the scope filter is this page or all pages', [...scopes].map((b) => b.textContent).join() === 'This page,All pages');
    await click(scopes[0]);
    check('picking a scope reports it', scope === 'page', scope);

    await click($('.comments-row'));
    check('clicking a row opens it', opened.length === 1 && typeof opened[0] === 'string');
    await click($$('.comments-head-actions button')[0]);
    check('the pin toggle is a discoverable control, not only a shortcut', acted.some((a) => a[0] === 'pins'));
    await click($$('.comments-head-actions button')[1]);
    check('and so is comment mode', acted.some((a) => a[0] === 'mode'));

    status = 'open';
    await render(
      React.createElement(ui.CommentsPanel, {
        reviews: [],
        status,
        onStatus: () => {},
        scope,
        onScope: () => {},
        openId: null,
        onOpen: () => {},
        onAct: () => {},
        onFocus: () => {},
        onDelete: () => {},
      })
    );
    check('an empty panel says how to make one', /Press/.test(container.textContent) && /click something/.test(container.textContent));
    check('and mentions the shortcut', $('.comments-empty kbd')?.textContent === 'C');

    // The ledger going wrong is worth a sentence: an empty panel because a
    // file could not be read looks exactly like a project nobody commented on.
    await render(
      React.createElement(ui.CommentsPanel, {
        reviews: [],
        status: 'open',
        onStatus: () => {},
        scope: 'project',
        onScope: () => {},
        openId: null,
        onOpen: () => {},
        onAct: () => {},
        onFocus: () => {},
        onDelete: () => {},
        problem: { kind: 'newer' },
      })
    );
    check('a ledger from a newer Stacki is explained', /newer version of Stacki/.test($('.comments-problem')?.textContent || ''));
    await render(
      React.createElement(ui.CommentsPanel, {
        reviews: [],
        status: 'open',
        onStatus: () => {},
        scope: 'project',
        onScope: () => {},
        openId: null,
        onOpen: () => {},
        onAct: () => {},
        onFocus: () => {},
        onDelete: () => {},
        problem: { kind: 'corrupt' },
      })
    );
    check('and so is a corrupt one — including that it was kept', /set aside rather than deleted/.test($('.comments-problem')?.textContent || ''));
  }

  // ── A thread ──────────────────────────────────────────────────────────────

  {
    const acted = [];
    const thread = (r, extra = {}) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ui.ReviewThread, {
          review: r,
          onAct: (action, args) => acted.push([action, args]),
          onFocus: () => acted.push(['focus']),
          onDelete: () => acted.push(['delete']),
          ...extra,
        }),
        React.createElement(ui.ConfirmHost)
      );

    await render(thread(review({ messages: [
      { id: 'rm_1', authorType: 'human', body: 'The pill is too tight on mobile.', createdAt: Date.now() },
      { id: 'rm_2', authorType: 'agent', body: 'Reduced the padding to 12px.', createdAt: Date.now() },
    ] })));
    check('every message is shown', $$('.review-msg').length === 2);
    check('a human message says who', /You/.test($$('.review-msg')[0].textContent));
    check('an agent message says so', /Agent/.test($$('.review-msg')[1].textContent));
    check('what it was left on is shown', /<span>/.test($('.review-target')?.textContent || ''), $('.review-target')?.textContent);
    check('including the words it had', /Learn more/.test($('.review-target')?.textContent || ''));

    const buttons = () => $$('.review-actions button');
    const named = (text) => buttons().find((b) => new RegExp(text, 'i').test(b.textContent));
    check('an open review offers resolve', !!named('Resolve'));
    check('and defer', !!named('Defer'));
    check('and not reopen — it is already open', !named('Reopen'));
    // The states that are deliberately not in the model are not offered either.
    for (const absent of ['Approve', 'Reject', 'Block', 'Assign', 'In progress', 'Won.t fix']) {
      check(`a thread does not offer "${absent}"`, !named(absent));
    }

    await click(named('Resolve'));
    check('resolve goes through the one action door', acted.some(([a]) => a === 'resolve'), JSON.stringify(acted));
    // Going to the element is not a decision about the review, so it is not a
    // third verb in the row — it is the line that says where the review is.
    check('the line that says where it is, is the way back to it', !!$('.review-target.can-go'));
    check('and it is not a button in the action row', !named('Show me'));
    await click($('.review-target.can-go'));
    check('clicking it goes there', acted.some(([a]) => a === 'focus'), JSON.stringify(acted));

    await click(named('Defer'));
    check('deferring asks why first', !!$('.review-defer textarea'));
    check('and offers somewhere to put a link to where it is tracked', !!$('.review-defer input'));
    await type($('.review-defer textarea'), 'Needs a product decision.');
    await act(async () => {
      $('.review-defer').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    const deferred = acted.find(([a]) => a === 'defer');
    check('and carries the reason with it', deferred && deferred[1].reason === 'Needs a product decision.', JSON.stringify(deferred));

    acted.length = 0;
    await render(thread(review({ status: 'resolved' })));
    check('a resolved review offers reopen', !!named('Reopen'));
    check('and not resolve again', !named('Resolve'));
    await click(named('Reopen'));
    check('reopen goes through the same door', acted.some(([a]) => a === 'reopen'));

    acted.length = 0;
    await render(thread(review({ status: 'deferred', deferredReason: 'Waiting on copy.', externalRefs: ['https://example.test/issues/9'] })));
    check('a deferred review shows why', /Waiting on copy/.test(container.textContent));
    check('and where it is tracked', /example.test\/issues\/9/.test(container.textContent));
    // The reference is where the work actually lives, so it has to open.
    // It looked like a link and did nothing.
    {
      const opened = [];
      dom.window.avb.openExternal = async (u) => opened.push(u);
      const link = $('.review-ref button');
      check('a web reference is something you can click', !!link);
      await click(link);
      check('and it opens in the browser, not in the editor', opened.join() === 'https://example.test/issues/9', JSON.stringify(opened));
    }
    // An external reference is a free string an agent wrote. Anything that is
    // not a web address is shown as text rather than dressed up as a link that
    // cannot work.
    await render(thread(review({ status: 'deferred', externalRefs: ['JIRA-4182', 'file:///etc/passwd'] })));
    check('a non-web reference is not made clickable', $$('.review-ref button').length === 0, String($$('.review-ref button').length));
    check('but it is still shown', /JIRA-4182/.test(container.textContent));

    // An orphan has to stay useful — it is the review, not a broken row.
    acted.length = 0;
    await render(thread(review({ anchorState: 'orphaned' })));
    check('an orphan says its element is gone', /element is gone/i.test($('.review-orphan')?.textContent || ''));
    check('but still shows the message', /too tight on mobile/.test(container.textContent));
    check('and still shows what it was about', /Learn more/.test(container.textContent));
    check('and can still be replied to', !!$('.review-reply textarea'));
    check('and resolved', !!named('Resolve'));
    check('and deferred', !!named('Defer'));
    check('but there is nowhere to go — so nothing offers to take you there', !$('.review-target.can-go'));
    check('though it still says what the element was', /Learn more/.test($('.review-target')?.textContent || ''));

    // A reply.
    acted.length = 0;
    await render(thread(review()));
    await type($('.review-reply textarea'), 'Also on tablet.');
    await act(async () => {
      $('.review-reply').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    check('a reply is sent with its words', acted.some(([a, args]) => a === 'reply' && args.message === 'Also on tablet.'), JSON.stringify(acted));
    check('and the box is emptied afterwards', $('.review-reply textarea').value === '');
    acted.length = 0;
    await act(async () => {
      $('.review-reply').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    check('an empty reply sends nothing', acted.length === 0);

    // Colour is the person's own filing; STATE is the shape. A marker has to
    // answer "is this done" without a legend, so the two must not share an
    // encoding.
    acted.length = 0;
    let colored = null;
    await render(thread(review({ color: 'violet' }), { onColor: (c) => (colored = c) }));
    check('the dot wears the comment\u2019s colour', /c-violet/.test($('.review-dot').className), $('.review-dot').className);
    check('and an open one is filled', /is-open/.test($('.review-dot').className));
    await click($('.review-dot-btn'));
    check('the dot opens the palette', $$('.review-swatch').length === 6, String($$('.review-swatch').length));
    check('and shows which one is on', $$('.review-swatch').filter((b) => b.classList.contains('on')).length === 1);
    await click($$('.review-swatch').find((b) => b.classList.contains('c-teal')));
    check('picking one reports it', colored === 'teal');
    check('and closes the palette', $$('.review-swatch').length === 0);

    await render(thread(review({ status: 'deferred', color: 'violet' })));
    check('a deferred review keeps its colour', /c-violet/.test($('.review-dot').className));
    check('and says so by being hollow rather than by changing colour', /is-deferred/.test($('.review-dot').className));
    await render(thread(review({ status: 'resolved', color: 'violet' })));
    check('a resolved one is a state, not a grouping', /is-resolved/.test($('.review-dot').className));
    await render(thread(review({ anchorState: 'orphaned', color: 'violet' })));
    check('and an orphan is marked on top of whatever state it is in', /orphaned/.test($('.review-dot').className) && /is-open/.test($('.review-dot').className));
    await render(thread(review()));
    check('a thread with no way to recolour just shows the dot', !$('.review-dot-btn'));

    // Deleting is a person's decision and is asked about first.
    acted.length = 0;
    await render(thread(review()));
    // Deleting sits with closing, in the header — not beside Resolve, where it
    // read as a fourth workflow verb.
    const bin = $('.review-thread-head .review-trash');
    check('a person can delete their own comment', !!bin);
    check('and it is not in among the workflow buttons', !$$('.review-actions button').some((b) => b.classList.contains('review-trash')));
    check('the action row holds at most two verbs', $$('.review-actions button').length <= 2, String($$('.review-actions button').length));
    await click(bin);
    check('deleting asks first', /Delete this comment\?/.test(document.body.textContent), document.body.textContent.slice(0, 120));
    check('and says what is lost', /cannot be brought back/.test(document.body.textContent));
    check('and offers resolving instead', /resolve it/i.test(document.body.textContent));
    check('and nothing was deleted while the question was up', !acted.some(([a]) => a === 'delete'));
    const cancel = [...document.body.querySelectorAll('button')].find((b) => /Cancel/.test(b.textContent));
    await click(cancel);
    check('saying no deletes nothing', !acted.some(([a]) => a === 'delete'));
  }

  // ── Pins ──────────────────────────────────────────────────────────────────

  {
    const opened = [];
    const items = [
      { id: 'rt_a', number: 1, color: 'violet', path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' },
      { id: 'rt_b', number: 2, path: '0.2', occurrence: 2, pin: { xRatio: 0, yRatio: 0 }, status: 'deferred', anchorState: 'attached' },
      { id: 'rt_c', number: 3, path: null, occurrence: null, pin: null, status: 'open', anchorState: 'orphaned' },
    ];
    const copies = [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 0, y: 100, w: 50, h: 50 },
      { x: 0, y: 200, w: 50, h: 50 },
    ];
    let rects = { '0.1': [{ x: 100, y: 200, w: 400, h: 100 }], '0.2': copies };
    let hidden = -1;
    // The two layers, laid out once — exactly as PreviewPane does it, so the
    // markers and the panel can never disagree about where a comment is.
    const pins = (extra = {}) => {
      const laid = ui.placePins(extra.items || items, extra.rects || rects);
      hidden = laid.hidden.length;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(ui.ReviewPins, {
          pins: laid.pins,
          visible: true,
          capturing: false,
          openId: null,
          onOpen: (id) => opened.push(id),
          ...extra,
        }),
        React.createElement(ui.ReviewSurface, {
          pins: laid.pins,
          frameBox: extra.frameBox || { left: 0, top: 0, width: 1000, height: 800 },
          capturing: false,
          openId: null,
          onOpen: (id) => opened.push(id),
          onAct: () => {},
          onFocus: () => {},
          onDelete: () => {},
          reviewById: () => review(),
          ...extra,
        })
      );
    };

    await render(pins());
    check('a pin is drawn for each review that has a box', $$('.review-pin').length === 2, String($$('.review-pin').length));
    const at = (id) => $$('.review-pin').find((p) => p.style.left === id);
    check('a pin sits where its ratios say', !!at('300px'), $$('.review-pin').map((p) => `${p.style.left},${p.style.top}`).join(' '));
    check('and wears its own colour', /c-violet/.test(at('300px').className), at('300px').className);
    check('and on the copy it was left on', $$('.review-pin').some((p) => p.style.top === '200px'), $$('.review-pin').map((p) => p.style.top).join());
    check('a deferred review reads differently from an open one', $$('.review-pin.is-deferred').length === 1);
    check('and it is the shape that differs, not the colour', $$('.review-pin.is-deferred')[0].className.includes('c-'), $$('.review-pin.is-deferred')[0].className);
    check('an orphan has no pin', $$('.review-pin').length === 2);
    check('and is reported rather than silently dropped', hidden === 1, String(hidden));

    // The layout moved. The pin has to move with it, or the comment is about
    // whatever has since slid under it. A fresh report, the way the page sends
    // one — not the same object edited, which is not something that can happen.
    rects = { '0.1': [{ x: 100, y: 600, w: 400, h: 100 }], '0.2': copies };
    await render(pins());
    check('a pin follows its element when the page reflows', $$('.review-pin').some((p) => p.style.top === '650px'), $$('.review-pin').map((p) => p.style.top).join());

    await click($('.review-pin'));
    check('clicking a pin opens its thread', opened.length === 1 && typeof opened[0] === 'string');

    // Several reviews on one spot are one marker with a number on it.
    const stacked = [
      { id: 'rt_1', number: 7, path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' },
      { id: 'rt_2', number: 8, path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' },
    ];
    await render(pins({ items: stacked }));
    check('two comments on one spot are one pin', $$('.review-pin').length === 1);
    check('it wears the first one\u2019s number', /^7/.test($('.review-pin').textContent), $('.review-pin').textContent);
    check('and says how many more are under it', /\+1/.test($('.review-pin').textContent), $('.review-pin').textContent);
    // The count sits in a corner badge rather than in the label, so a cluster
    // is never wider than its number — #128 is a real name and has to fit.
    check('the count is a badge, not more characters in the label', !!$('.review-pin .review-pin-more'));
    check('so the label is only the number', $('.review-pin').firstChild.textContent === '7', JSON.stringify($('.review-pin').firstChild.textContent));

    // Three digits is a real number once a project has been reviewed for a
    // while, and it has to read as a name rather than as a smudge.
    await render(pins({ items: [{ id: 'rt_big', number: 128, color: 'blue', path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' }] }));
    check('a three-digit number is shown in full', $('.review-pin').textContent === '128', $('.review-pin').textContent);

    await render(pins({ visible: false }));
    check('the pins can be turned off', $$('.review-pin').length === 0);

    // The composer.
    let body = '';
    let submitted = false;
    let cancelled = false;
    await render(
      pins({
        draft: { x: 120, y: 240, label: 'pill', breakpoint: 'phone', occurrence: 1, occurrenceCount: 4, body },
        onDraftChange: (v) => {
          body = v;
        },
        onDraftSubmit: () => {
          submitted = true;
        },
        onDraftCancel: () => {
          cancelled = true;
        },
      })
    );
    check('the composer appears at the spot that was clicked', $('.review-composer')?.style.left === '120px');
    check('it says what is being commented on', /pill/.test($('.review-composer-target')?.textContent || ''));
    check('and at which breakpoint', /phone/.test($('.review-composer-target')?.textContent || ''));
    check('and which copy of a repeated node', /copy 2\/4/.test($('.review-composer-target')?.textContent || ''));
    check('posting is refused while it is empty', $('.review-composer button.primary').disabled === true);
    await type($('.review-composer textarea'), 'Too tight.');
    check('typing is reported up', body === 'Too tight.');
    await render(
      pins({
        draft: { x: 120, y: 240, label: 'pill', body: 'Too tight.' },
        onDraftChange: () => {},
        onDraftSubmit: () => {
          submitted = true;
        },
        onDraftCancel: () => {
          cancelled = true;
        },
      })
    );
    check('and then posting is allowed', $('.review-composer button.primary').disabled === false);
    await act(async () => {
      $('.review-composer form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    check('submitting posts the comment', submitted === true);
    await click([...container.querySelectorAll('.review-composer button')].find((b) => /Cancel/.test(b.textContent)));
    check('and cancelling is right there', cancelled === true);

    // Near an edge, a box has to open inwards. The frame clips its overflow,
    // so one that opened outwards would be half a sentence.
    const box = { left: 0, top: 0, width: 400, height: 400 };
    const composing = (x, y) =>
      pins({ frameBox: box, draft: { x, y, label: 'pill', body: '' }, onDraftChange: () => {}, onDraftSubmit: () => {}, onDraftCancel: () => {} });
    dom.window.innerWidth = 800;
    dom.window.innerHeight = 600;
    await render(composing(40, 40));
    check('a comment with room opens down and to the right', !$('.review-composer').className.includes('flip'));
    check('and is positioned in the window, not in the frame', $('.review-composer').style.left === '40px');
    await render(composing(760, 40));
    check('one against the right of the window opens leftwards', $('.review-composer').className.includes('flip-x'));
    await render(composing(40, 560));
    check('one against the bottom opens upwards', $('.review-composer').className.includes('flip-y'));
    await render(composing(760, 560));
    check('one in the corner does both', /flip-x/.test($('.review-composer').className) && /flip-y/.test($('.review-composer').className));
    // A comment on a 375px phone canvas: the panel is wider than the frame, so
    // drawing it inside the frame could only ever have cut it in half.
    dom.window.innerWidth = 1600;
    await render(pins({ frameBox: { left: 700, top: 100, width: 375, height: 800 }, draft: { x: 180, y: 300, label: 'pill', body: '' }, onDraftChange: () => {}, onDraftSubmit: () => {}, onDraftCancel: () => {} }));
    check('a pin inside a narrow frame still opens a full-width panel', $('.review-composer').style.left === '880px', $('.review-composer').style.left);
    check('and it is fixed to the window rather than clipped by the canvas', !$('.frame-clip .review-composer'));
    // A panel is kept on screen whatever the arithmetic says: a note shoved
    // off the edge of the window is a note nobody can read or close.
    dom.window.innerWidth = 800;
    await render(pins({ frameBox: { left: 700, top: 100, width: 375, height: 800 }, draft: { x: 180, y: 300, label: 'pill', body: '' }, onDraftChange: () => {}, onDraftSubmit: () => {}, onDraftCancel: () => {} }));
    check('and never off the edge of it', parseFloat($('.review-composer').style.left) <= 740, $('.review-composer').style.left);
    await render(pins({ frameBox: null, draft: { x: 10, y: 10, label: 'pill', body: '' }, onDraftChange: () => {}, onDraftSubmit: () => {}, onDraftCancel: () => {} }));
    check('and with no frame measured yet, nothing is drawn on a guess', !$('.review-composer'));
  }

  // ── The canvas: comment mode, and staying out of the photograph ───────────

  {
    let targeted = null;
    let selected = 0;
    const items = [{ id: 'rt_a', path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' }];
    const pane = (over = {}) =>
      React.createElement(ui.PreviewPane, {
        devUrl: 'http://localhost:4321',
        devStatus: 'on',
        route: '/',
        refreshKey: 0,
        crumbs: [{ id: null, label: 'index' }],
        selPath: '0.1',
        overlayInfo: () => ({ label: 'pill', kind: 'element', tag: 'span', nodeKind: 'element' }),
        onSelectPath: () => {
          selected++;
        },
        device: 'desktop',
        onDevice: () => {},
        onCanvasReport: () => {},
        commenting: false,
        pinsVisible: true,
        reviewItems: items,
        reviewById: () => review(),
        onReviewOpen: () => {},
        onReviewAct: () => {},
        onReviewFocus: () => {},
        onReviewDelete: () => {},
        onReviewHidden: () => {},
        onCommentTarget: (hit) => {
          targeted = hit;
        },
        ...over,
      });

    await render(pane());
    const iframe = $('iframe');
    check('the canvas renders', !!iframe);
    // The frame reports the boxes it was asked about; without them there is
    // nowhere for a pin to be.
    const say = async (data) => {
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent('message', { data, source: iframe.contentWindow })
        );
      });
    };
    await say({ type: 'avb:rects', rects: { '0.1': [{ x: 10, y: 20, w: 200, h: 60 }] }, spacing: {} });
    check('a pin is drawn over the canvas', $$('.review-pin').length === 1);
    check('it is inside the frame overlay, not the page', !!$('.frame-clip .review-pin'));
    check('and not inside the iframe itself', iframe.contentDocument?.querySelector('.review-pin') == null);

    // A click with comment mode off selects, as it always did.
    await say({ type: 'avb:click-node', path: '0.2', occurrence: 0, outside: false, x: 30, y: 40 });
    check('a click still selects when comment mode is off', selected === 1, String(selected));
    check('and nothing was targeted for a comment', targeted === null);

    // On, and the same click means something else entirely.
    await render(pane({ commenting: true }));
    await say({ type: 'avb:rects', rects: { '0.1': [{ x: 10, y: 20, w: 200, h: 60 }] }, spacing: {} });
    await say({ type: 'avb:click-node', path: '0.1', occurrence: 2, outside: false, x: 60, y: 50 });
    check('a click in comment mode picks a target', !!targeted, JSON.stringify(targeted));
    check('and does NOT change the selection', selected === 1, String(selected));
    check('it carries the path the canvas mapped', targeted.path === '0.1');
    check('and which copy was under the pointer', targeted.occurrence === 2);
    check('and where in the page it landed', targeted.point.x === 60 && targeted.point.y === 50, JSON.stringify(targeted.point));
    check('the canvas says a click means something else now', !!$('.frame-clip.commenting'));

    // A click the canvas could not place is reported as such rather than
    // silently opening a composer attached to nothing.
    targeted = null;
    await say({ type: 'avb:click-node', path: null, occurrence: 0, outside: true, x: 5, y: 5 });
    check('an unplaceable click is still reported', targeted && targeted.path === null && targeted.outside === true, JSON.stringify(targeted));

    // The photograph. This is the check the whole overlay design exists for.
    await render(pane());
    await say({ type: 'avb:rects', rects: { '0.1': [{ x: 10, y: 20, w: 200, h: 60 }] }, spacing: {} });
    check('before a capture, the markers are there', $$('.review-pin').length === 1);
    check('and so are the outlines', $$('.node-outline').length > 0);
    await act(async () => {
      await ui.beginCapture({ target: 'viewport' });
    });
    check('a capture takes the comment pins off the canvas', $$('.review-pin').length === 0, `${$$('.review-pin').length} left`);
    check('along with the selection outlines, as it always did', $$('.node-outline').length === 0);
    await act(async () => {
      await ui.endCapture();
    });
    check('and puts them both back afterwards', $$('.review-pin').length === 1 && $$('.node-outline').length > 0);

    // The composer and the popover are chrome too.
    await render(pane({ reviewDraft: { x: 10, y: 10, label: 'pill', body: '' }, onReviewDraftChange: () => {}, onReviewDraftSubmit: () => {}, onReviewDraftCancel: () => {} }));
    await say({ type: 'avb:rects', rects: { '0.1': [{ x: 10, y: 20, w: 200, h: 60 }] }, spacing: {} });
    check('the composer is on the canvas', !!$('.review-composer'));
    await act(async () => {
      await ui.beginCapture({ target: 'viewport' });
    });
    check('and it is not in the photograph either', !$('.review-composer'));
    await act(async () => {
      await ui.endCapture();
    });
  }

  // ── The wiring nobody looks at ────────────────────────────────────────────

  {
    const paneSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'), 'utf8');
    check('the pins are tracked, so the page reports boxes for them', /reviewItems \|\| \[\]\)\.map\(\(i\) => i\?\.path\)/.test(paneSource));
    check('and they are drawn inside the frame overlay', /frame-clip[\s\S]{0,4000}<ReviewPins/.test(paneSource));
    // The app turns selection off on the body and opts regions back in. A
    // comment is words somebody wrote to be read and quoted, so they have to
    // be selectable — they were not.
    const cssSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    check('comment text can be selected and copied', /\.review-body,[\s\S]{0,200}user-select: text/.test(cssSource));
    check('including the reference and the deferral reason', /\.review-note span,[\s\S]{0,200}user-select: text/.test(cssSource));
    // A resolved pin appears only in the Resolved and All views, and when it
    // does it has to read as finished rather than as one more thing to do.
    check('a resolved pin is drawn quietly', /\.review-pin\.is-resolved \{[\s\S]{0,200}opacity: 0\.5;/.test(cssSource));
    check('and comes up to full strength when it is the one being looked at', /\.review-pin\.is-resolved:hover:not\(:disabled\) \{[^}]*opacity: 1/.test(cssSource));
    // The cluster badge sits BESIDE the pin. In the corner it covered the
    // number, which is the one thing on a pin that has to stay readable — it
    // is how a person and an agent name the same review.
    check('the "+n" badge is clear of the number', /\.review-pin-more \{[\s\S]{0,500}left: 100%;/.test(cssSource));
    check('rather than sitting over it', !/\.review-pin-more \{[\s\S]{0,500}right: -\d/.test(cssSource));
    // And the number sits on the pin's optical centre, not its box centre —
    // the tail is a square corner and the other three are quarter-circles, so
    // dead centre reads as pushed away from the tail.
    check('and it is nudged onto the optical centre', /\.review-pin-n \{[\s\S]{0,120}transform: translate\(-0\.5px, 0\.5px\)/.test(cssSource));
    check('while the header stays a drag handle', /\.review-popover \.review-thread-head \{ cursor: grab; user-select: none; \}/.test(cssSource));

    const pinsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'ReviewPins.jsx'), 'utf8');
    check('the marker layer takes itself out of a capture', /if \(capturing \|\| !visible\) return null;/.test(pinsSource));
    check('and so does the panel layer', /if \(capturing \|\| !frameBox\) return null;/.test(pinsSource));
    check('the pin number is its own element so it can be placed', /className="review-pin-n"/.test(pinsSource));
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    check('the panel and MCP go through the same action door', /reviewsAct\(\{ action, threadId: id, authorType: 'human'/.test(appSource));
    check('a review is anchored with the app’s own key builder', /selectionKeys: keysFor\(target\.id\)/.test(appSource));
    check('and described with the app’s own breadcrumbs', /crumbs: crumbsFor\(target\.id\)/.test(appSource));
    check('comment mode never writes review state into React', !/setReviews\(/.test(appSource));
    // openFile sets the current file before it reads it and the model after,
    // so for one turn the app names a component while still holding the page's
    // tree. A focus that waited only for the filename looked the node up in the
    // wrong model and reported a perfectly present element as gone.
    check('focus waits for the model, not just the filename', /state\.model !== left/.test(appSource));
    // The same stale pair, in the other consumer. Every whole-model load is
    // stamped with the file it came from, and both readers demand the stamp
    // match before they judge an anchor against the tree in hand.
    check('every model read from disk is stamped with its file', (appSource.match(/setPageState\(\{ \.\.\.\w+, file: /g) || []).length === 3, String((appSource.match(/setPageState\(\{ \.\.\.\w+, file: /g) || []).length));
    check('the open-model lookup demands the stamp match', /modelMatchesFile\(state, open\.path\)/.test(appSource));
    check('and the anchor health check refuses to judge a mismatched pair', /if \(!modelOf\(openRel\)\) return;/.test(appSource));
    // A pin is about the PAGE, not about the file that happens to be open.
    check('every review on the page gets a pin, not only the open file\u2019s', /pinnable\(r\.status, reviewFilter\) && onReviewPage\(r\)/.test(appSource));
    check('and a component\u2019s nodes are named by their own file', /markerPathFor\(keys\[keys\.length - 1\], reviewPageFile\)/.test(appSource));
    check('the canvas is asked to measure them', /reviewItems \|\| \[\]\)\.map\(\(i\) => i\?\.path\)/.test(paneSource));
    // Reading must not damage what it reads. Clicking down a list of comments
    // runs a focus for each, and a preview that is still starting fails every
    // one of them — recording those as orphaned would mark somebody's whole
    // review list lost just for looking at it.
    check('transient focus failures are named', /TRANSIENT = new Set\(\['not_open', 'moved_away'\]\)/.test(appSource));
    check('and never written to the ledger', /if \(!result\.transient && result\.anchorState/.test(appSource));
    const svcSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'review', 'index.js'), 'utf8');
    check('nor written by the MCP path either', /if \(answer\.anchorState && !answer\.transient\)/.test(svcSource));
    check('and an agent is told "not ready" rather than "orphaned"', /answer\.transient \? 'not_ready' : 'orphaned'/.test(svcSource));

    // Choosing a comment from the list means "show me this".
    check('opening a comment from the panel goes to it', /if \(picked && picked\.anchorState !== 'orphaned'\) void focusReviewFromUi\(picked\)/.test(appSource));
    // And picking something else on the canvas puts the panel away, instead of
    // leaving it over the page swallowing clicks.
    check('selecting on the canvas closes an open thread', /setReviewOpenId\(null\);\n\s+if \(kind === 'nothing'\) return;/.test(appSource));
    check('and every navigation goes through that wait', !/settleOnFile/.test(appSource) && /goTo\(plan\.page\.file/.test(appSource) && /goTo\(drill\.componentFile/.test(appSource));
    check('and nothing in the renderer names a review file', !/reviews\.json|userData/.test(appSource));
  }

  if (failures.length) {
    console.error(`\nreview-ui: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`review-ui: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
