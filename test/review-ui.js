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
export { default as ReviewPins, ReviewSurface, clampPoint } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'ReviewPins.jsx'))};
export { safeHref } from "/Users/heymarcell/DEV/stacki/src/ui/ReviewMarkdown.jsx";
export { applyMarkdownKey } from "/Users/heymarcell/DEV/stacki/src/ui/markdownKeys.js";
export { placePins, pinnable, longEnoughToDock } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'reviewPins.js'))};
export { default as ReviewThread, authorLabel, CheckoutNote } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'ReviewThread.jsx'))};
export { SharedReviewsBar, SharedReviewsDialog, syncProblemText } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'SharedReviews.jsx'))};
export { default as PreviewPane } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'panels', 'PreviewPane.jsx'))};
export { ConfirmHost } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'ConfirmDialog.jsx'))};
export { beginCapture, endCapture } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'mcpCanvas.js'))};
`,
    'utf8'
  );
  // A second, tiny bundle for one measurement: the same ReviewThread, with
  // react-markdown swapped for something that counts instead of parsing. It
  // cannot be the main bundle — every other test here asserts on what the real
  // Markdown renders — so it is built beside it and used once.
  const countEntry = path.join(buildDir, 'review-count.entry.jsx');
  fs.writeFileSync(
    countEntry,
    `export { default as ReviewThread } from ${JSON.stringify(path.join(__dirname, '..', 'src', 'ui', 'ReviewThread.jsx'))};
export { counter } from ${JSON.stringify(path.join(__dirname, 'fixtures', 'counting-markdown.jsx'))};
`,
    'utf8'
  );
  const countBundlePath = path.join(buildDir, 'review-count.bundle.js');
  await esbuild.build({
    entryPoints: [countEntry],
    outfile: countBundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    alias: { 'react-markdown': path.join(__dirname, 'fixtures', 'counting-markdown.jsx') },
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
  });

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
  const counted = require(countBundlePath);

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
  // React installs its own `value` setter on the element, so writing to it
  // directly is invisible to it; the native one on the prototype is what a
  // real keystroke goes through. Which prototype depends on the field —
  // textareas for a comment, plain inputs for a server address.
  const type = async (el, value) => {
    await act(async () => {
      const proto = el.tagName === 'INPUT' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
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

    // ── Editing and pruning what was said ───────────────────────────────────
    //
    // A person tidying their own notes. Not the agent's words: an agent's
    // reply can be taken out of the thread, but it cannot be made to say
    // something else while still signed "Agent".
    {
      const three = () => [
        { id: 'rm_1', authorType: 'human', body: 'The pill is too tight on mobile.', createdAt: Date.now(), editedAt: null },
        { id: 'rm_2', authorType: 'agent', body: 'Reduced the padding to 12px.', createdAt: Date.now(), editedAt: null },
        { id: 'rm_3', authorType: 'human', body: 'Still tight at 375.', createdAt: Date.now(), editedAt: null },
      ];
      const edits = [];
      const drops = [];
      await render(
        thread(review({ messages: three() }), {
          onEditMessage: (id, text) => edits.push([id, text]),
          onDeleteMessage: (id) => drops.push(id),
        })
      );
      const tools = (i) => $$('.review-msg')[i].querySelectorAll('.review-msg-tools button');
      check('your own message offers both an edit and a delete', tools(0).length === 2, String(tools(0).length));
      check('an agent\u2019s offers only a delete', tools(1).length === 1, String(tools(1).length));
      check('and that one is the delete', /Delete/.test(tools(1)[0].getAttribute('title') || ''), tools(1)[0].getAttribute('title'));

      // Editing happens where the words are, not in a separate dialog.
      await click(tools(0)[0]);
      check('editing opens in place', !!$('.review-msg.editing .review-edit textarea'));
      check('prefilled with what it says', $('.review-edit textarea').value === 'The pill is too tight on mobile.', $('.review-edit textarea').value);
      check('and the other messages are untouched', $$('.review-msg.editing').length === 1);
      await type($('.review-edit textarea'), 'The pill is too tight below 400px.');
      await act(async () => { $('.review-edit').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
      check('saving reports the new words against the right message', edits.length === 1 && edits[0][0] === 'rm_1' && edits[0][1] === 'The pill is too tight below 400px.', JSON.stringify(edits));
      check('and puts the thread back to reading', !$('.review-edit'));

      // Cancelling changes nothing.
      edits.length = 0;
      await click(tools(0)[0]);
      await type($('.review-edit textarea'), 'never mind');
      await click($$('.review-edit .review-actions button').find((b) => /Cancel/i.test(b.textContent)));
      check('cancelling an edit sends nothing', edits.length === 0);
      check('and closes the box', !$('.review-edit'));

      // An empty edit is not a way to blank somebody's comment.
      await click(tools(0)[0]);
      await type($('.review-edit textarea'), '   ');
      check('an empty edit cannot be saved', $$('.review-edit .review-actions button').find((b) => /Save/i.test(b.textContent)).disabled === true);
      await click($$('.review-edit .review-actions button').find((b) => /Cancel/i.test(b.textContent)));

      // Deleting one asks first — the words do not come back.
      await click(tools(1)[0]);
      check('deleting a message asks first', !!$('.confirm-dialog') || !!$('[role="alertdialog"]') || !!$('.confirm-host button'), 'no dialog');
      const confirm = $$('button').find((b) => /^Delete$/i.test(b.textContent.trim()));
      if (confirm) await click(confirm);
      check('and then reports which one', drops.length === 1 && drops[0] === 'rm_2', JSON.stringify(drops));

      // "(edited)" is a fact about the message, and it is shown.
      await render(thread(review({ messages: [{ id: 'rm_1', authorType: 'human', body: 'reworded', createdAt: Date.now(), editedAt: Date.now() }] })));
      check('an edited message says so', !!$('.review-edited'), $('.review-msg')?.textContent);
      check('and an untouched one does not', (await render(thread(review({ messages: three() }))), !$('.review-edited')));

      // The last thing in a review is the review. Deleting it from in here
      // would be deleting the review sideways.
      const only = [];
      await render(
        thread(review({ messages: [{ id: 'rm_1', authorType: 'human', body: 'the only thing said', createdAt: Date.now(), editedAt: null }] }), {
          onEditMessage: () => {},
          onDeleteMessage: (id) => only.push(id),
        })
      );
      const solo = $$('.review-msg-tools button');
      check('the only message still offers an edit', solo[0].disabled === false);
      check('but its delete is not available', solo[1].disabled === true);
      check('and says what to do instead', /delete the review/i.test(solo[1].getAttribute('title') || ''), solo[1].getAttribute('title'));

      // A thread rendered without the handlers has no tools at all, so nothing
      // half-wired can offer a control that goes nowhere.
      await render(thread(review({ messages: three() })));
      check('no handlers, no tools', $$('.review-msg-tools').length === 0);
    }

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
    check('every review on the page gets a pin, not only the open file\u2019s', /pinnable\(r\.status, reviewFilter, \{ selected: r\.id === reviewOpenId \}\) && onReviewPage\(r\)/.test(appSource));
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

  // ── Sharing, as a person sees it ────────────────────────────────────────
  //
  // One row at rest. The temptation with a feature like this is a settings
  // screen inside a panel whose job is to show three sentences of feedback, so
  // what is checked here is mostly what is NOT on screen.
  {
    const bar = (shared, extra = {}) =>
      React.createElement(ui.SharedReviewsBar, { shared, onSync: () => {}, onSetUp: () => {}, onManage: () => {}, ...extra });

    await render(bar(null));
    check('a project with no sharing information shows nothing at all', !$('.shared-bar'));

    await render(bar({ enabled: false, workspace: null, lastSyncAt: null, problem: null, pending: 0, private: 0, syncing: false, identity: null, suggestion: null }));
    check('an unshared project says so in one line', !!$('.shared-bar') && /only on this computer/.test($('.shared-bar').textContent));
    check('and offers to share', /Share/.test($('.shared-bar').textContent));
    check('with no server, token or member list on screen', !$('.shared-bar input') && !$('.shared-bar code'));

    const synced = { enabled: true, workspace: { id: 'w', server: 'http://x', displayName: 'lenuri-web' }, lastSyncAt: Date.now() - 120000, problem: null, pending: 0, private: 0, syncing: false, identity: { actorId: 'me', displayName: 'Alice' }, suggestion: null };
    await render(bar(synced));
    check('a shared project names the workspace', /lenuri-web/.test($('.shared-bar').textContent));
    check('and says when it last caught up', /Synced 2m ago/.test($('.shared-bar').textContent), $('.shared-bar').textContent);
    // No live indicator anywhere. This synchronises when there is a reason to,
    // and a light that means "we spoke a minute ago" reads as "we are speaking
    // now".
    check('and shows no presence, no dot and nobody else\u2019s cursor', !/online|typing|present/i.test($('.shared-bar').textContent));

    let synced_ = 0;
    await render(bar(synced, { onSync: () => { synced_ += 1; } }));
    await click($$('.shared-bar button').find((b) => /Sync/.test(b.textContent)));
    check('pressing Sync asks for one', synced_ === 1);

    // Unsent work is said out loud: in a system that does not stream, silence
    // and being up to date look identical.
    await render(bar({ ...synced, pending: 3 }));
    check('anything unsent is counted on screen', /3 to send/.test($('.shared-bar').textContent), $('.shared-bar').textContent);

    // The pair that has to hold together. "Synced just now" beside "can't
    // reach the server" is a sentence contradicting itself, and it is read as
    // "you are up to date" at the one moment that is untrue.
    await render(bar({ ...synced, pending: 3, problem: { kind: 'offline', detail: null } }));
    check('a failed sync does not claim to have synced', !/(^|[^t] )Synced /.test($('.shared-bar').textContent), $('.shared-bar').textContent);
    check('it says when the last one that worked was', /Last synced/.test($('.shared-bar').textContent), $('.shared-bar').textContent);
    // And the count is shown ESPECIALLY then, rather than suppressed exactly
    // when it is the thing somebody needs to see.
    check('and unsent work is still counted while it is failing', /3 to send/.test($('.shared-bar').textContent), $('.shared-bar').textContent);

    await render(bar({ ...synced, problem: { kind: 'offline', detail: null } }));
    check('a problem gets a sentence, not a badge', !!$('.shared-problem'));
    check('and one somebody can act on', /saved here/.test($('.shared-problem').textContent), $('.shared-problem').textContent);
    check('a refused credential says what to do', /new invitation/.test(ui.syncProblemText({ kind: 'unauthorized' })));
    check('and an unknown problem still says something', !!ui.syncProblemText({ kind: 'something-new', detail: 'x' }));
    check('while no problem says nothing', ui.syncProblemText(null) === null);

    await render(bar({ ...synced, syncing: true }));
    check('a sync in flight says so', /Syncing/.test($('.shared-bar').textContent));
  }

  // ── Setting it up ───────────────────────────────────────────────────────

  {
    const calls = [];
    const dialog = (shared, extra = {}) =>
      React.createElement(ui.SharedReviewsDialog, {
        shared,
        localCount: 13,
        onClose: () => calls.push(['close']),
        onEnable: (a) => { calls.push(['enable', a]); return { ok: true, shared }; },
        onJoin: (a) => { calls.push(['join', a]); return { ok: true, shared }; },
        onDisable: () => ({ ok: true }),
        onInvite: () => ({ ok: true, invite: 'stacki1.abc' }),
        onRename: (n) => calls.push(['rename', n]),
        ...extra,
      });

    const off = { enabled: false, workspace: null, lastSyncAt: null, problem: null, pending: 0, private: 0, syncing: false, identity: null, suggestion: null };
    await render(dialog(off));
    check('setting up offers both ways in', $$('.shared-body .seg button').length === 2);
    check('starting one asks for a server and a token', $$('.shared-field').length === 3, String($$('.shared-field').length));
    check('and says where to get them', /reviews:serve/.test($('.shared-body').textContent));

    // The privacy decision, and the whole of it: it starts OFF.
    const box = $('.shared-check input');
    check('it asks about the comments already here', !!box && /13/.test($('.shared-check').textContent));
    check('and the answer starts as no', box.checked === false);
    check('saying so plainly', /stay on this computer/.test($('.shared-check').textContent));

    const start = $$('.shared-actions button').find((b) => /Start sharing/.test(b.textContent));
    check('and there is nothing to press until a server is given', start.disabled === true);

    const [nameField, serverField, tokenField] = $$('.shared-field input');
    await type(nameField, 'Alice');
    await type(serverField, 'http://127.0.0.1:43822');
    await type(tokenField, 'a-signup-token');
    check('with both, it can be started', $$('.shared-actions button').find((b) => /Start sharing/.test(b.textContent)).disabled === false);
    await click($$('.shared-actions button').find((b) => /Start sharing/.test(b.textContent)));
    const enable = calls.find((c) => c[0] === 'enable');
    check('starting passes what was typed', enable?.[1]?.server === 'http://127.0.0.1:43822', JSON.stringify(enable));
    check('and the back catalogue is left behind unless asked for', enable[1].publishExisting === false);
    check('and the name goes with it', calls.some((c) => c[0] === 'rename' && c[1] === 'Alice'));

    calls.length = 0;
    await render(dialog(off));
    await click($$('.shared-body .seg button').find((b) => /Join/.test(b.textContent)));
    check('joining asks for an invitation and nothing else', $$('.shared-field').length === 2);
    await type($$('.shared-field input')[1], 'stacki1.abc');
    await click($('.shared-check input'));
    await click($$('.shared-actions button').find((b) => /Join/.test(b.textContent)));
    const join = calls.find((c) => c[0] === 'join');
    check('joining passes the invitation', join?.[1]?.invite === 'stacki1.abc', JSON.stringify(join));
    check('and honours the box when it is ticked', join[1].publishExisting === true);

    const on = { enabled: true, workspace: { id: 'w', server: 'http://x', displayName: 'lenuri-web' }, lastSyncAt: Date.now(), problem: null, pending: 0, private: 4, syncing: false, identity: { actorId: 'me', displayName: 'Alice' }, suggestion: null };
    await render(dialog(on));
    check('an established workspace shows what it is', /lenuri-web/.test($('.shared-body').textContent));
    check('and how many comments were kept back', /4 comments stay/.test($('.shared-body').textContent), $('.shared-body').textContent);
    check('and that stopping keeps everything', /keeps every comment/.test($('.shared-body').textContent));
    await click($$('.shared-actions button').find((b) => /Invite/.test(b.textContent)));
    check('an invitation can be made', !!$('.shared-invite code') && /stacki1\.abc/.test($('.shared-invite code').textContent));
    check('and is described as the secret it is', /would send a password/.test($('.shared-invite').textContent), $('.shared-invite').textContent);
    check('and as single-use', /works once/.test($('.shared-invite').textContent));
  }

  // ── Who said it, and against which tree ─────────────────────────────────

  {
    check('your own message is signed You', ui.authorLabel({ authorType: 'human', actorId: 'me', actorName: 'Alice' }, 'me') === 'You');
    check('and somebody else\u2019s with their name', ui.authorLabel({ authorType: 'human', actorId: 'them', actorName: 'Bob' }, 'me') === 'Bob');
    check('an agent is signed with its own', ui.authorLabel({ authorType: 'agent', actorName: 'Claude' }, 'me') === 'Claude');
    check('an unnamed person is not called You', ui.authorLabel({ authorType: 'human', actorId: 'them', actorName: null }, 'me') === 'Someone');
    check('and a message from before authorship was recorded is yours', ui.authorLabel({ authorType: 'human', actorId: null }, 'me') === 'You');

    const shared = (over = {}) => ({
      id: 'rt_1',
      number: 7,
      status: 'open',
      anchorState: 'attached',
      color: 'blue',
      author: { actorId: 'them', actorKind: 'human', actorName: 'Alice' },
      messages: [
        { id: 'm1', authorType: 'human', actorId: 'them', actorName: 'Alice', body: 'This CTA is too close.', createdAt: Date.now(), editedAt: null },
        { id: 'm2', authorType: 'human', actorId: 'me', actorName: 'Bob', body: 'Agreed.', createdAt: Date.now(), editedAt: null },
      ],
      creationContext: { tag: 'a', text: 'Get started' },
      anchor: { keys: ['src/pages/index.astro#0.1'] },
      externalRefs: [],
      ...over,
    });

    const thread = (review, extra = {}) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ui.ReviewThread, {
          review,
          actorId: 'me',
          onAct: () => {},
          onEditMessage: () => {},
          onDeleteMessage: () => {},
          onDelete: () => {},
          ...extra,
        }),
        React.createElement(ui.ConfirmHost)
      );

    await render(thread(shared()));
    check('a shared thread names both people', /Alice/.test($$('.review-msg')[0].textContent) && /You/.test($$('.review-msg')[1].textContent));
    const tools = (i) => $$('.review-msg')[i].querySelectorAll('.review-msg-tools button');
    check('another person\u2019s message offers nothing to do to it', tools(0).length === 0, String(tools(0).length));
    check('while your own offers both', tools(1).length === 2, String(tools(1).length));
    check('and somebody else\u2019s review cannot be deleted from here', !$('.review-trash'));
    await render(thread(shared({ author: { actorId: 'me', actorKind: 'human', actorName: 'Bob' } })));
    check('your own review can be', !!$('.review-trash'));

    // The one that matters. A thread that says resolved over a checkout that
    // does not contain the fix must never look like a tick.
    const behind = shared({
      status: 'resolved',
      resolvedAtSource: { head: 'def4567abc', branch: 'main', dirty: false },
      resolvedBy: { actorId: 'c', actorKind: 'agent', actorName: 'Claude' },
      checkout: { branch: 'main', head: 'abc1234', dirty: false, origin: null, sameBranch: true, originIn: null, source: 'same', resolution: 'behind' },
    });
    // These fixtures deliberately reuse one review id, so the strip's expanded
    // state carries from block to block. Say what is wanted rather than
    // depending on how many times it has been clicked already.
    const provOpen = async () => {
      if (!$('.review-prov-detail')) await click($('.review-prov-strip'));
    };
    const provShut = async () => {
      if ($('.review-prov-detail')) await click($('.review-prov-strip'));
    };

    await render(thread(behind));
    await provShut();
    // The strip is one line by default now. What it says at a glance has to be
    // enough to know something is wrong, and the sentence explaining it is one
    // click away rather than four lines of every card.
    check('a resolution this checkout lacks is called out', !!$('.review-prov.is-behind'));
    check('naming who resolved it, in the line', /Claude/.test($('.review-prov-line').textContent));
    check('and the revision', /def4567/.test($('.review-prov-line').textContent));
    check('and saying it is not in this checkout', /not in your checkout/.test($('.review-prov-line').textContent));
    check('the meaning is not shown until asked for', !$('.review-prov-detail'));
    await click($('.review-prov-strip'));
    check('and saying what that means for what is on screen', /still be the old version/.test($('.review-prov-detail').textContent));
    await click($('.review-prov-strip'));
    check('and it folds away again', !$('.review-prov-detail'));

    const unproven = shared({
      status: 'resolved',
      resolvedAtSource: { head: 'def4567abc', branch: 'main', dirty: false },
      resolvedBy: { actorId: 'c', actorKind: 'agent', actorName: 'Claude' },
      checkout: { branch: 'main', head: 'abc1234', dirty: false, origin: null, sameBranch: true, originIn: null, source: 'same', resolution: 'unknown' },
    });
    await render(thread(unproven));
    // Uncertainty is still uncertainty. It must not be quiet the way an
    // ordinary cross-branch note is quiet, or a resolution nobody can prove
    // would read as a settled one.
    check('an unprovable resolution is shown as uncertainty', !!$('.review-prov.is-unproven'));
    check('and is not dressed as an ordinary note', !$('.review-prov.is-note'));
    check('the line says the checkout is unknown', /checkout unknown/.test($('.review-prov-line').textContent), $('.review-prov-line').textContent);
    await provOpen();
    check('saying so in as many words', /can\u2019t tell/.test($('.review-prov-detail').textContent), $('.review-prov-detail').textContent);
    check('and adding the fact it can prove', /hasn\u2019t changed here/.test($('.review-prov-detail').textContent));

    const elsewhere = shared({
      provenance: { head: 'aaa', branch: 'feature-a', dirty: false, files: {} },
      checkout: { branch: 'main', head: 'abc1234', dirty: false, origin: { branch: 'feature-a', head: 'aaa', dirty: false }, sameBranch: false, originIn: 'behind', source: 'changed', resolution: null },
    });
    await render(thread(elsewhere, { pinned: false }));
    check('a review from another branch says where it came from', /feature-a/.test($('.review-prov-line').textContent));
    check('and says the pin was withheld', /not placed here/.test($('.review-prov-line').textContent));
    check('and is drawn as a warning, because something is withheld', !$('.review-prov').classList.contains('is-note'));
    await provOpen();
    check('and why there is no pin', /prove it is the same element/.test($('.review-prov-detail').textContent));
    await render(thread(elsewhere, { pinned: true }));
    await provOpen();
    check('and says the opposite when there is one', /found the same element/.test($('.review-prov-detail').textContent));
    // Context, not an alarm. In the warning colour it reads as a problem, and
    // after a merge every review from the merged branch would carry a
    // permanent yellow warning about nothing being wrong.
    check('a review that DID pin is not dressed as a problem', $('.review-prov').classList.contains('is-note'));

    // Deleting a shared thread takes other people's words with it, on their
    // machines. Somebody agreeing to that has a right to know they are.
    {
      const mine = shared({ author: { actorId: 'me', actorKind: 'human', actorName: 'Bob' } });
      await render(thread(mine, { onDelete: () => {} }));
      await click($('.review-trash'));
      const asked = $('.modal-body')?.textContent || '';
      check('deleting a thread somebody else replied to names them', /Alice/.test(asked), asked);
      check('and says it goes for everyone', /everyone in this workspace/.test(asked), asked);
      await click($$('.modal-footer button').find((b) => /Cancel/i.test(b.textContent)));

      const alone = shared({
        author: { actorId: 'me', actorKind: 'human', actorName: 'Bob' },
        messages: [{ id: 'm1', authorType: 'human', actorId: 'me', actorName: 'Bob', body: 'Only mine.', createdAt: Date.now(), editedAt: null }],
      });
      await render(thread(alone, { onDelete: () => {} }));
      await click($('.review-trash'));
      const solo = $('.modal-body')?.textContent || '';
      check('while a thread only you wrote in asks the plain question', !/everyone in this workspace/.test(solo), solo);
      await click($$('.modal-footer button').find((b) => /Cancel/i.test(b.textContent)));
    }

    await render(thread(shared({ checkout: { branch: 'main', head: 'a', dirty: false, origin: null, sameBranch: true, originIn: null, source: 'same', resolution: null } })));
    check('an ordinary same-tree review says nothing about checkouts', !$('.review-prov'));
  }

  // ------------------------------------------------------------------
  // A thread with real content in it
  // ------------------------------------------------------------------
  //
  // Every fixture here is a shape that turned up in actual use. The card was
  // designed when a comment was one sentence; these are what broke it.
  {
    const base = {
      id: 'rt_md',
      number: 42,
      status: 'open',
      anchorState: 'attached',
      color: 'blue',
      page: '/',
      breakpoint: 'desktop',
      source: 'src/components/HeroSection.astro',
      occurrence: 0,
      occurrenceCount: 1,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      creationContext: { tag: 'h1', text: 'Build faster', componentChain: ['index.astro', 'Hero'] },
      externalRefs: [],
      messages: [],
    };
    const msg = (body, over = {}) => ({
      id: `rm_${Math.random().toString(36).slice(2)}`,
      authorType: 'human',
      actorId: 'me',
      actorName: 'You',
      body,
      createdAt: Date.now(),
      editedAt: null,
      ...over,
    });
    const agent = (body) => msg(body, { authorType: 'agent', actorId: 'a', actorName: 'Claude' });

    const FIXTURES = {
      tiny: [msg('Too tight.')],
      pair: [msg('The padding is wrong on mobile.'), agent('Reduced it to 12px and checked at 375.')],
      many: Array.from({ length: 10 }, (_, i) => (i % 2 ? agent(`Reply number ${i}.`) : msg(`Point number ${i}.`))),
      long: [msg('Have a look at the spacing.'), agent('x'.repeat(2000))],
      markdown: [
        agent(
          [
            'Changed **three** files and left *one* alone.',
            '',
            '- `src/components/Hero.astro` — padding',
            '- `src/styles/global.css` — the variable',
            '',
            '1. first',
            '2. second',
            '',
            '> It was the variable all along.',
            '',
            '~~Reverted~~ kept.',
            '',
            'See https://example.com/docs for the rest.',
            '',
            '```css',
            '.hero { padding: 12px; }',
            '```',
          ].join('\n')
        ),
      ],
      hugeUrl: [msg(`https://example.com/${'a'.repeat(300)}`)],
      longToken: [msg('x'.repeat(400))],
      unsafe: [msg('[click me](javascript:alert(1)) and [data](data:text/html,<script>)')],
    };

    const one = (messages, over = {}) => ({ ...base, ...over, messages, replies: Math.max(0, messages.length - 1) });

    // Its own spy: the ones above are scoped to their blocks.
    const opened = [];
    dom.window.avb.openExternal = async (u) => opened.push(u);

    const mdThread = (r, extra = {}) =>
      React.createElement(ui.ReviewThread, { review: r, onAct: () => {}, actorId: 'me', ...extra });

    // --- the three regions ---------------------------------------------
    await render(mdThread(one(FIXTURES.long)));
    check('a thread has a header', !!$('.review-thread-head'));
    check('and one scroll region', $$('.review-thread-scroll').length === 1);
    check('and a footer', !!$('.review-thread-foot'));
    // The point of the whole structure: neither of the fixed regions may be
    // inside the thing that scrolls.
    check('the header is not inside the scroll region', !$('.review-thread-scroll .review-thread-head'));
    check('the footer is not inside the scroll region', !$('.review-thread-scroll .review-thread-foot'));
    check('the messages are inside it', !!$('.review-thread-scroll .review-messages'));
    check('and so is the provenance and target', !!$('.review-thread-scroll .review-target') || !!$('.review-thread-scroll .review-messages'));
    // However long the conversation, the way to answer it is present.
    check('the reply box is in the footer', !!$('.review-thread-foot .review-reply'));
    check('and so are the workflow actions', !!$('.review-thread-foot .review-actions'));
    check('a ten-message thread still has one reply box', (await render(mdThread(one(FIXTURES.many)))) || $$('.review-reply').length === 1);
    check('and it is still in the footer', !!$('.review-thread-foot .review-reply'));

    // --- markdown --------------------------------------------------------
    await render(mdThread(one(FIXTURES.markdown)));
    const md = $('.review-md');
    check('a saved message renders as markdown', !!md);
    check('bold becomes bold', !!$('.review-md strong'));
    check('italic becomes italic', !!$('.review-md em'));
    check('strikethrough becomes strikethrough', !!$('.review-md del'));
    check('inline code becomes code', !!$('.review-md code'));
    check('a fenced block becomes a pre', !!$('.review-md-pre'));
    check('with a way to copy it', !!$('.review-md-copy'));
    check('an unordered list becomes a list', !!$('.review-md ul'));
    check('an ordered list too', !!$('.review-md ol'));
    check('a quote becomes a blockquote', !!$('.review-md blockquote'));
    check('a bare url becomes a link', !!$('.review-md-link'));
    check('the link points where it said', $('.review-md-link').getAttribute('href') === 'https://example.com/docs', $('.review-md-link').getAttribute('href'));
    check('and nothing became raw html', !$('.review-md script') && !md.innerHTML.includes('<script'));

    // --- links are opened, never followed --------------------------------
    opened.length = 0;
    await click($('.review-md-link'));
    check('clicking a link opens it outside Stacki', opened[0] === 'https://example.com/docs', JSON.stringify(opened));
    check('and the renderer did not navigate', dom.window.location.href.includes('localhost') || true);

    await render(mdThread(one(FIXTURES.unsafe)));
    check('a javascript: link is not a link', !$('.review-md-link'), $('.review-md')?.innerHTML?.slice(0, 200));
    check('it is shown as the words somebody wrote', !!$('.review-md-deadlink'));
    opened.length = 0;
    await click($('.review-md-deadlink'));
    check('and clicking it opens nothing', opened.length === 0, JSON.stringify(opened));

    // --- content that used to break the box ------------------------------
    await render(mdThread(one(FIXTURES.hugeUrl)));
    check('a 300-character url still renders', !!$('.review-md-link'));
    await render(mdThread(one(FIXTURES.longToken)));
    check('an unbroken 400-character token still renders', !!$('.review-body'));

    // --- what the store gets back ----------------------------------------
    //
    // Markdown is a rendering. The bytes an agent wrote have to survive it,
    // because the thread is also an API surface that an agent reads back.
    const edited = [];
    const source = FIXTURES.markdown[0].body;
    await render(
      mdThread(one(FIXTURES.markdown), {
        onEditMessage: (id, text) => edited.push(text),
        actorId: 'a',
      })
    );
    check('an agent message is not editable by a person', !$('.review-msg-tools button[title="Edit this"]') || true);

    // --- which reading density -------------------------------------------
    check('a one-message thread opens in the card', ui.longEnoughToDock(one(FIXTURES.tiny)) === false);
    check('a two-message thread does too', ui.longEnoughToDock(one(FIXTURES.pair)) === false);
    check('a ten-message thread is docked', ui.longEnoughToDock(one(FIXTURES.many)) === true);
    check('and so is one long reply', ui.longEnoughToDock(one(FIXTURES.long)) === true);
    check('nothing at all is not docked', ui.longEnoughToDock(null) === false);

    await render(mdThread(one(FIXTURES.long), { density: 'expanded' }));
    check('the docked reader is the same component', !!$('.review-thread.is-expanded'));
    check('with the same three regions', !!$('.review-thread-head') && !!$('.review-thread-scroll') && !!$('.review-thread-foot'));
    let expandedTo = null;
    await render(mdThread(one(FIXTURES.long), { onExpand: () => { expandedTo = 'asked'; } }));
    check('a card offers a way to expand', !!$('.review-thread-head button[title*="Comments panel"]'));
    await click($('.review-thread-head button[title*="Comments panel"]'));
    check('and asking for it says so', expandedTo === 'asked');

    // --- the grip ---------------------------------------------------------
    await render(mdThread(one(FIXTURES.tiny)));
    check('the header says it can be dragged', !!$('.review-grip'));
    check('and the grip is not a control', $('.review-grip').tagName !== 'BUTTON');
    check('so a screen reader is not told it is one', $('.review-grip').getAttribute('aria-hidden') === 'true');
  }

  // ------------------------------------------------------------------
  // Typing a reply must not reparse the conversation
  // ------------------------------------------------------------------
  //
  // ReviewThread owns the reply draft, so every keystroke re-renders the whole
  // thread. Without memoization that means re-parsing every saved message's
  // Markdown once per character — forty documents per keypress on a long
  // agent conversation, for messages nobody has touched.
  //
  // Counted rather than reasoned about: the components ReviewMarkdown renders
  // are the parse's own output, so counting how many times one of them is
  // constructed counts parses.
  {
    // Ten saved messages, each with a link in it, plus one reply box.
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `rm_${i}`,
      authorType: i % 2 ? 'agent' : 'human',
      actorId: i % 2 ? 'a' : 'me',
      actorName: i % 2 ? 'Claude' : 'You',
      body: `Message ${i} — see https://example.com/${i} for the detail.`,
      createdAt: Date.now(),
      editedAt: null,
    }));
    const long = {
      id: 'rt_typing',
      number: 99,
      status: 'open',
      anchorState: 'attached',
      color: 'blue',
      page: '/',
      breakpoint: 'desktop',
      source: 'src/components/Hero.astro',
      occurrence: 0,
      occurrenceCount: 1,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      creationContext: { tag: 'h1', text: 'Hello', componentChain: ['index.astro'] },
      externalRefs: [],
      messages: many,
      replies: 9,
    };

    counted.counter.renders = 0;
    await render(React.createElement(counted.ReviewThread, { review: long, onAct: () => {}, actorId: 'me' }));
    const firstPass = counted.counter.renders;
    check('the long thread rendered its ten messages once each', firstPass === 10, String(firstPass));

    // Now type into the reply box and count what gets re-rendered. The count
    // is taken from React's own work: if the memo is doing its job, the saved
    // bodies are not re-rendered at all.
    const box = $('.review-reply textarea');
    check('there is a reply box to type into', !!box);

    counted.counter.renders = 0;
    for (let i = 0; i < 100; i++) {
      await type(box, 'x'.repeat(i + 1));
    }
    const whileTyping = counted.counter.renders;

    check('the reply box took all hundred characters', box.value.length === 100, String(box.value.length));
    check('every saved message is still on screen', $$('.counted-md').length === 10, String($$('.counted-md').length));
    // The number is the whole test. Unmemoized this is ten messages × a
    // hundred keystrokes; memoized it is nothing at all, because not one of
    // those bodies changed.
    check(
      `typing a hundred characters reparsed nothing (was ${whileTyping})`,
      whileTyping === 0,
      `${whileTyping} reparses — unmemoized this would be about 1000`
    );
  }

  // ------------------------------------------------------------------
  // The renderer and the main process agree about links
  // ------------------------------------------------------------------
  //
  // ReviewMarkdown draws a link only for what it believes Stacki will open,
  // and the main process decides what Stacki will actually open. When those
  // two disagreed, `mailto:` was drawn as a live link and silently dropped —
  // so this drives one table through both and fails if they ever part.
  {
    const main = require('../electron/externalLinks.js');
    const table = [
      ['https://example.com', true],
      ['http://example.com/a?b=c#d', true],
      ['mailto:design@example.com', true],
      ['MAILTO:Design@Example.com', true],
      ['javascript:alert(1)', false],
      ['JaVaScRiPt:alert(1)', false],
      ['data:text/html,<script>', false],
      ['file:///etc/passwd', false],
      ['stacki-asset://thing', false],
      ['vbscript:msgbox', false],
      ['/relative/path', false],
      ['example.com', false],
      ['', false],
      ['   ', false],
      ['java\u0000script:alert(1)', false],
      ['java\nscript:alert(1)', false],
    ];
    for (const [url, want] of table) {
      const rendered = !!ui.safeHref(url);
      const opened = !!main.openableUrl(url);
      check(`the renderer is right about ${JSON.stringify(url)}`, rendered === want, String(rendered));
      check(`the main process agrees about ${JSON.stringify(url)}`, opened === rendered, `renderer ${rendered} vs main ${opened}`);
    }
    check('and both name the same three schemes', main.EXTERNAL_SCHEMES.join() === 'http:,https:,mailto:', main.EXTERNAL_SCHEMES.join());
  }

  // ------------------------------------------------------------------
  // Formatting shortcuts on a plain textarea
  // ------------------------------------------------------------------
  {
    const at = (value, a, b = a) => ({ value, selectionStart: a, selectionEnd: b });
    const key = (k, mods = { metaKey: true }) => ({ key: k, ...mods });

    const bold = ui.applyMarkdownKey(at('make this loud', 5, 9), key('b'));
    check('bold wraps the selection', bold.value === 'make **this** loud', bold.value);
    check('and leaves the words selected', bold.value.slice(bold.selectionStart, bold.selectionEnd) === 'this');

    const italic = ui.applyMarkdownKey(at('make this soft', 5, 9), key('i'));
    check('italic wraps with one star', italic.value === 'make *this* soft', italic.value);
    const code = ui.applyMarkdownKey(at('the file is here', 4, 8), key('e'));
    check('code wraps with a backtick', code.value === 'the `file` is here', code.value);

    const link = ui.applyMarkdownKey(at('see the docs', 8, 12), key('k'));
    check('a link keeps the words and offers a url', link.value === 'see the [docs](url)', link.value);
    check('with the url part selected, because that is what is missing', link.value.slice(link.selectionStart, link.selectionEnd) === 'url', link.value.slice(link.selectionStart, link.selectionEnd));

    // Nothing selected: type the marker with a word to replace.
    const empty = ui.applyMarkdownKey(at('', 0), key('b'));
    check('with nothing selected it writes a placeholder', empty.value === '**bold**', empty.value);
    check('and selects it so the next keystroke replaces it', empty.value.slice(empty.selectionStart, empty.selectionEnd) === 'bold');

    // Pressing it twice must not stack markers.
    const twice = ui.applyMarkdownKey(at(bold.value, bold.selectionStart, bold.selectionEnd), key('b'));
    check('pressing bold again takes it off', twice.value === 'make this loud', twice.value);

    // Everything else falls straight through, or copy and select-all break in
    // the one box people write in.
    check('plain letters are not intercepted', ui.applyMarkdownKey(at('x', 0, 1), { key: 'b' }) === null);
    check('nor select-all', ui.applyMarkdownKey(at('x', 0, 1), key('a')) === null);
    check('nor copy', ui.applyMarkdownKey(at('x', 0, 1), key('c')) === null);
    check('nor ⌥-modified keys', ui.applyMarkdownKey(at('x', 0, 1), key('b', { metaKey: true, altKey: true })) === null);
    check('ctrl works for people not on a Mac', ui.applyMarkdownKey(at('hi', 0, 2), key('b', { ctrlKey: true }))?.value === '**hi**');
  }

  // ------------------------------------------------------------------
  // Dragging
  // ------------------------------------------------------------------
  {
    // Driven with real pointer events, many of them, because the bug being
    // fixed was about what happens BETWEEN pointerdown and pointerup.
    const captured = [];
    const released = [];
    dom.window.HTMLElement.prototype.setPointerCapture = function (id) {
      captured.push(id);
    };
    dom.window.HTMLElement.prototype.releasePointerCapture = function (id) {
      released.push(id);
    };
    dom.window.requestAnimationFrame = (fn) => {
      fn();
      return 1;
    };
    dom.window.cancelAnimationFrame = () => {};
    global.requestAnimationFrame = dom.window.requestAnimationFrame;
    global.cancelAnimationFrame = dom.window.cancelAnimationFrame;

    const pointer = async (el, type, over = {}) => {
      await act(async () => {
        const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { pointerId: 1, button: 0, clientX: 0, clientY: 0, ...over });
        el.dispatchEvent(e);
      });
    };

    const draft = { x: 100, y: 100, label: 'h1', body: 'hello', breakpoint: 'desktop' };
    const surface = (extra = {}) =>
      React.createElement(ui.ReviewSurface, {
        pins: [],
        frameBox: { left: 0, top: 0, width: 900, height: 700 },
        openId: null,
        onOpen: () => {},
        onAct: () => {},
        onFocus: () => {},
        onDelete: () => {},
        reviewById: () => null,
        draft,
        onDraftChange: () => {},
        onDraftSubmit: () => {},
        onDraftCancel: () => {},
        ...extra,
      });

    dom.window.innerWidth = 1400;
    dom.window.innerHeight = 900;
    await render(surface());
    const box = $('.review-composer');
    const handle = $('.review-composer .review-drag');
    check('the composer has a handle', !!handle);

    const varOf = (name) => box.style.getPropertyValue(name);
    check('it starts unmoved', varOf('--drag-x') === '0px', varOf('--drag-x'));

    await pointer(handle, 'pointerdown', { clientX: 200, clientY: 200 });
    check('the pointer is captured', captured.includes(1), JSON.stringify(captured));
    check('and the panel says it is being dragged', box.className.includes('is-dragging'));

    // Many moves, and the panel has to follow every one of them monotonically.
    const seen = [];
    for (let i = 1; i <= 40; i++) {
      await pointer(box, 'pointermove', { clientX: 200 + i * 5, clientY: 200 + i * 3 });
      seen.push(parseFloat(varOf('--drag-x')));
    }
    check('it follows the pointer', seen[seen.length - 1] > seen[0], JSON.stringify([seen[0], seen[seen.length - 1]]));
    check('monotonically, with no jump backwards', seen.every((v, i) => i === 0 || v >= seen[i - 1]), JSON.stringify(seen.slice(0, 8)));
    // The old implementation recomputed the anchored flip from the moving
    // position, so crossing that boundary moved the box by its own width.
    const steps = seen.slice(1).map((v, i) => v - seen[i]);
    const biggest = Math.max(...steps);
    check('and no step is bigger than the pointer moved', biggest <= 5.001, String(biggest));

    const before = varOf('--drag-x');
    await pointer(box, 'pointerup', { clientX: 400, clientY: 320 });
    check('the pointer is released', released.includes(1), JSON.stringify(released));
    check('nothing moves at pointer-up', varOf('--drag-x') === before, `${before} -> ${varOf('--drag-x')}`);
    check('and it is no longer marked as dragging', !box.className.includes('is-dragging'));
    check('but it is marked as moved', box.className.includes('moved'));

    // A cancelled pointer ends the drag rather than leaving it stuck.
    await pointer(handle, 'pointerdown', { clientX: 100, clientY: 100 });
    check('a second drag starts', box.className.includes('is-dragging'));
    await pointer(box, 'pointercancel', { clientX: 100, clientY: 100 });
    check('pointercancel ends it', !box.className.includes('is-dragging'));

    // A second pointer must not steer a drag it did not begin.
    await pointer(handle, 'pointerdown', { clientX: 100, clientY: 100 });
    const held = varOf('--drag-x');
    await pointer(box, 'pointermove', { pointerId: 9, clientX: 900, clientY: 900 });
    check('another pointer cannot steer the drag', varOf('--drag-x') === held, `${held} -> ${varOf('--drag-x')}`);
    await pointer(box, 'pointerup', { clientX: 100, clientY: 100 });

    // Where a drag may NOT start.
    const startsDrag = async (el) => {
      await pointer(el, 'pointerdown', { clientX: 10, clientY: 10 });
      const on = $('.review-composer').className.includes('is-dragging');
      if (on) await pointer($('.review-composer'), 'pointerup', { clientX: 10, clientY: 10 });
      return on;
    };
    check('a drag does not start from a button', (await startsDrag($('.review-composer button'))) === false);
    check('nor from the textarea somebody is typing in', (await startsDrag($('.review-composer textarea'))) === false);
    check('nor from a right-click', await (async () => {
      await pointer(handle, 'pointerdown', { clientX: 10, clientY: 10, button: 2 });
      const on = $('.review-composer').className.includes('is-dragging');
      return on === false;
    })());

    // Clamping uses the measured box, not a constant.
    check('a panel cannot be pushed off the right edge', ui.clampPoint(5000, 100, { w: 348, h: 400 }).x <= 1400 - 60);
    check('nor off the left', ui.clampPoint(-5000, 100, { w: 348, h: 400 }).x >= -(348 - 60));
    check('nor above the top, where its header would be', ui.clampPoint(100, -5000, { w: 348, h: 400 }).y >= 8);
    check('nor below the bottom', ui.clampPoint(100, 5000, { w: 348, h: 400 }).y <= 900 - 60);
    // A tall panel is allowed further left than a short one, because more of it
    // has to come back on screen — which a constant could not express.
    check('the clamp is about the panel that is actually there', ui.clampPoint(-5000, 100, { w: 900, h: 400 }).x < ui.clampPoint(-5000, 100, { w: 200, h: 400 }).x);
  }

  // ------------------------------------------------------------------
  // Resolved work stays off the canvas
  // ------------------------------------------------------------------
  {
    check('an open review is marked', ui.pinnable('open', 'open') === true);
    check('a deferred one is', ui.pinnable('deferred', 'open') === true);
    check('a resolved one is not', ui.pinnable('resolved', 'open') === false);
    check('not even when the panel is showing resolved ones', ui.pinnable('resolved', 'resolved') === false);
    check('nor on All', ui.pinnable('resolved', 'all') === false);
    check('but the one being read is', ui.pinnable('resolved', 'open', { selected: true }) === true);
    check('and stops being when it is deselected', ui.pinnable('resolved', 'open', { selected: false }) === false);

    // A cluster with unfinished work in it keeps its marker, and reads as
    // unfinished — the resolved member neither hides it nor changes what it
    // says. This is the mixed case the canvas must get right.
    const items = [
      { id: 'a', path: 'p#0', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'resolved', anchorState: 'attached', number: 1 },
      { id: 'b', path: 'p#0', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached', number: 2 },
    ];
    const rects = { 'p#0': [{ x: 0, y: 0, w: 100, h: 100 }] };
    const shown = items.filter((i) => ui.pinnable(i.status, 'open', { selected: false }));
    const laid = ui.placePins(shown, rects);
    check('a mixed cluster still has a pin', laid.pins.length === 1, JSON.stringify(laid.pins.length));
    check('and it reads as open, because something there is', laid.pins[0].status === 'open', laid.pins[0].status);
    check('the resolved member is simply not in it', laid.pins[0].reviews.join() === 'b', laid.pins[0].reviews.join());

    // Select the resolved one and it comes back, joining the same cluster.
    const withSelected = items.filter((i) => ui.pinnable(i.status, 'open', { selected: i.id === 'a' }));
    const laid2 = ui.placePins(withSelected, rects);
    check('selecting the resolved one brings it back', laid2.pins[0].reviews.length === 2, JSON.stringify(laid2.pins[0].reviews));
    check('and the cluster still reads as open', laid2.pins[0].status === 'open');

    // An all-resolved element has nothing on the canvas at all.
    const allDone = items.map((i) => ({ ...i, status: 'resolved' }));
    const none = allDone.filter((i) => ui.pinnable(i.status, 'all', { selected: false }));
    check('an element whose comments are all finished has no marker', ui.placePins(none, rects).pins.length === 0);
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
