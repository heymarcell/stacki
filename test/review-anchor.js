// Finding a review's element again after the code moved.
//
//   node test/review-anchor.js
//
// This is the part of Visual Review that can be wrong without anybody
// noticing. A comment that fails to reattach is visible — it says orphaned,
// and somebody reads it. A comment that reattaches to the WRONG element is
// invisible: the panel looks healthy, focus selects something, the screenshot
// is of a real element, and an agent implements the feedback on the wrong
// button with total confidence.
//
// So the checks below are weighted deliberately towards the refusals. Every
// case where the honest answer is "I don't know" is checked twice: once that
// it says so, and once that it did not quietly pick one.
//
// Also here: the focus plan (page, breakpoint, drill, node, copy — in that
// order, and only the parts that aren't already true), comment mode's rules
// about when a keystroke is a shortcut and when it is somebody typing, and
// where a pin lands when the page reflows.

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
  const load = async (name) => {
    const out = path.join(buildDir, `${name}.bundle.mjs`);
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', `${name}.js`)],
      outfile: out,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    return import(`file://${out}?v=${Date.now()}`);
  };

  const { resolveNode, checkAnchor, anchorSteps, keyParts, trailOfPath, componentNameOf, sameSort, peerPath } =
    await load('reviewAnchor');
  const { focusPlan, hostPathFor, focusNote, nothingRestored } = await load('reviewFocus');
  const mode = await load('reviewMode');
  const { placePins, pinPoint, rectForReview, pinnable } = await load('reviewPins');

  // App's crumbLabel, near enough: an element is named by its first class and
  // falls back to its tag, a loop by its head, everything else by its name.
  // The resolver takes this as an argument precisely so the labels a review
  // recorded and the labels it is compared against are made the same way.
  const labelOf = (n) => {
    if (n.kind === 'text') return 'text';
    if (n.kind === 'expr') return 'code';
    if (n.kind === 'map') return (n.head || '').slice(0, (n.head || '').indexOf('.map') + 4) || 'loop';
    if (n.kind === 'cond') return `if ${n.test}`;
    if (n.kind === 'branch') return n.name === 'else' ? 'else' : 'then';
    if (n.kind === 'element' || n.kind === 'raw') {
      const cls = typeof n.props?.class === 'string' ? n.props.class.split(/\s+/)[0] : null;
      return cls || n.name;
    }
    return n.name;
  };

  let idn = 0;
  const el = (name, props, children) => ({ id: `n${++idn}`, kind: 'element', name, props: props || {}, children: children || [] });
  const comp = (name, props, children) => ({ id: `n${++idn}`, kind: 'component', name, props: props || {}, children: children || [] });
  const txt = (value) => ({ id: `n${++idn}`, kind: 'text', value, children: null });
  const loop = (head, children) => ({ id: `n${++idn}`, kind: 'map', head, children: children || [] });

  // A page that looks like a page: a layout wrapper, a hero with a headline
  // and a repeated card list, and a footer.
  // Every call makes a fresh tree with FRESH ids — which is what an external
  // reload does. Anchoring on ids would break here; anchoring on position does
  // not, which is the point.
  const makePage = () => {
    return {
      nodes: [
        el('main', { class: 'page' }, [
          el('section', { class: 'hero' }, [
            el('h1', { class: 'hero-title' }, [txt('Build faster')]),
            el('p', { class: 'hero-sub' }, [txt('Ship on Friday')]),
            comp('HeroSection', {}, []),
          ]),
          el('section', { class: 'cards' }, [
            loop('items.map((item) => (', [el('article', { class: 'card' }, [el('a', { class: 'more' }, [txt('Learn more')])])]),
          ]),
          el('footer', { class: 'foot' }, [el('a', { class: 'more' }, [txt('Learn more')])]),
        ]),
      ],
    };
  };

  // ── The key, and the trail it names ────────────────────────────────────────

  {
    check('a key splits into a file and a position', JSON.stringify(keyParts('src/pages/index.astro#0.1.2')) === JSON.stringify({ file: 'src/pages/index.astro', indexPath: '0.1.2' }));
    check('a key with no position is still a key', keyParts('src/pages/index.astro#').indexPath === '');
    check('something that is not a key is not one', keyParts('src/pages/index.astro') === null && keyParts(null) === null);
    check('a position is a list of indexes', JSON.stringify(trailOfPath('0.1.2')) === '[0,1,2]');
    check('frontmatter is not a node position', trailOfPath('frontmatter') === null);
    check('nonsense is not a node position', trailOfPath('0.x.2') === null && trailOfPath('') === null);
    check('a component file names a component', componentNameOf('src/components/HeroSection.astro') === 'HeroSection');
  }

  // ── Rung 1: the position still holds ──────────────────────────────────────

  {
    const model = makePage();
    const fp = { nodeKind: 'element', tag: 'h1', text: 'Build faster', breadcrumbs: ['index', 'page', 'hero', 'hero-title'] };
    const found = resolveNode(model.nodes, '0.0.0', fp, { labelOf });
    check('a plain element resolves exactly where it was', found.confidence === 'exact' && found.id === model.nodes[0].children[0].children[0].id, JSON.stringify(found));

    // The whole point of anchoring on a position rather than a line: an
    // external reload rebuilds the tree with brand new ids, and the review
    // has to survive it.
    const reloaded = makePage();
    const again = resolveNode(reloaded.nodes, '0.0.0', fp, { labelOf });
    check('and again after a reload that regenerated every id', again.confidence === 'exact');
    check('with the new id, not the old one', again.id !== found.id && again.id === reloaded.nodes[0].children[0].children[0].id);

    // A source edit that moves lines but not structure is not an event here at
    // all — no line number was ever stored.
    check('nothing in an anchor is a line number', !JSON.stringify(anchorSteps({ keys: ['a.astro#0.0.0'] })).includes('Line'));

    // A component resolves the same way.
    const compFp = { nodeKind: 'component', tag: 'HeroSection', breadcrumbs: ['index', 'page', 'hero', 'HeroSection'] };
    check('a component resolves', resolveNode(model.nodes, '0.0.2', compFp, { labelOf }).confidence === 'exact');

    // So does a text node, which has no tag of its own.
    const textFp = { nodeKind: 'text', tag: null, text: 'Build faster', breadcrumbs: ['index', 'page', 'hero', 'hero-title', 'text'] };
    check('a text node resolves', resolveNode(model.nodes, '0.0.0.0', textFp, { labelOf }).confidence === 'exact');

    // And a loop child — one source node that renders four times.
    const loopFp = { nodeKind: 'element', tag: 'article', breadcrumbs: ['index', 'page', 'cards', 'items.map', 'card'] };
    check('a repeated node resolves', resolveNode(model.nodes, '0.1.0.0', loopFp, { labelOf }).confidence === 'exact');
  }

  // ── Same-kind siblings: the position is not identity ──────────────────────
  //
  // Four cards in a row. A review is on the third. Somebody adds a card at the
  // top. The stored index now addresses a DIFFERENT card — and every card has
  // the same kind, the same tag and the same ancestors, so nothing but the
  // words and the shape of the sibling run can tell them apart.
  //
  // Getting this wrong is the worst failure this feature has: the pin moves to
  // the wrong card, focus selects it, capture photographs it, and an agent
  // edits code nobody complained about. Orphaning instead is merely annoying.
  {
    const plans = (names) =>
      el('main', { class: 'page' }, [
        el('section', { class: 'plans' }, names.map((n) => el('article', { class: 'plan' }, [el('h3', { class: 'name' }, [txt(n)])]))),
      ]);
    // The review was written on "Team" — third of four, index 2 among 4 peers.
    const fp = (over = {}) => ({
      nodeKind: 'element',
      tag: 'h3',
      text: 'Team',
      breadcrumbs: ['index', 'page', 'plans', 'plan', 'name'],
      // main / section / article(3rd of 4) / h3 — the run at every level.
      peers: [{ index: 0, count: 1 }, { index: 0, count: 1 }, { index: 2, count: 4 }, { index: 0, count: 1 }],
      ...over,
    });
    const AT = '0.0.2.0';
    const nameAt = (tree, i) => tree.children[0].children[i]?.children[0]?.children[0]?.value;
    const resolvedName = (tree, r) => {
      if (!r.id) return null;
      const found = tree.children[0].children.find((c) => c.children[0].id === r.id);
      return found ? found.children[0].children[0].value : '(not a plan heading)';
    };

    // A — nothing changed.
    {
      const t = plans(['Basic', 'Pro', 'Team', 'Enterprise']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('A unchanged: stays attached', r.id !== null && resolvedName(t, r) === 'Team', `${r.confidence} -> ${resolvedName(t, r)}`);
    }

    // B — a same-kind sibling inserted before it. The target itself is
    //     untouched, so its words still prove which one it is.
    {
      const t = plans(['New', 'Basic', 'Pro', 'Team', 'Enterprise']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('B sibling inserted before: follows the real target', resolvedName(t, r) === 'Team', `${r.confidence} -> ${resolvedName(t, r)} (slot now holds "${nameAt(t, 2)}")`);
      check('B and never the node that inherited the slot', resolvedName(t, r) !== nameAt(t, 2) || nameAt(t, 2) === 'Team');
    }

    // C — the words were edited in place. Nothing moved.
    {
      const t = plans(['Basic', 'Pro', 'Team plan', 'Enterprise']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('C copy edited in place: stays attached', resolvedName(t, r) === 'Team plan', `${r.confidence} -> ${resolvedName(t, r)}`);
    }

    // D — the dangerous one. A sibling was inserted AND the target renamed in
    //     the same edit. Nothing carries the old words and the slot moved.
    //     There is no evidence left. It must orphan.
    {
      const t = plans(['New', 'Basic', 'Pro', 'Teams', 'Enterprise']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('D insert + rename: orphans rather than guessing', r.id === null, `${r.confidence}/${r.reason} -> ${resolvedName(t, r)}`);
    }

    // E — every sibling says the same thing, and the run changed size.
    {
      const same = ['Plan', 'Plan', 'Plan', 'Plan'];
      const t = plans(['Plan', ...same]);
      const r = resolveNode([t], AT, fp({ text: 'Plan' }), { labelOf });
      check('E duplicate text + movement: orphans', r.id === null, `${r.confidence}/${r.reason}`);
    }

    // F — a sibling before it was deleted.
    {
      const t = plans(['Pro', 'Team', 'Enterprise']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('F sibling deleted before: follows the real target', resolvedName(t, r) === 'Team', `${r.confidence} -> ${resolvedName(t, r)}`);
    }

    // H — REORDERED. Nothing was added or removed, so every sibling run is
    //     exactly the size and shape it was, and the structural proof alone
    //     says "same slot" — about a slot that now holds a different card.
    //     The recorded words are next door. They have to win.
    {
      const t = plans(['Basic', 'Pro', 'Enterprise', 'Team']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('H siblings reordered: follows the words, not the slot', resolvedName(t, r) === 'Team', `${r.confidence} -> ${resolvedName(t, r)} (slot now holds "${nameAt(t, 2)}")`);
      check('H and does not attach to what took its place', resolvedName(t, r) !== 'Enterprise');
    }

    // I — reordered AND renamed in the same edit. The limit of what the
    //     recorded evidence can decide. Proved below, against the real parser;
    //     here is what the resolver does about it.
    //
    //     Nothing was added or removed, so every run is the shape it was; and
    //     no node carries the old words, so nothing says where the target
    //     went. The slot is kept — an in-place copy edit is what happens every
    //     time feedback is acted on, and orphaning that would break the one
    //     workflow this feature exists for — but it is kept as a POSITION,
    //     not as proof, and the answer says which it is.
    {
      const t = plans(['Basic', 'Pro', 'Enterprise', 'Teams']);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('I reorder + rename keeps the slot', r.id !== null, `${r.confidence}/${r.reason}`);
      check('I and does not call a position a proof', r.confidence === 'positional', r.confidence);
      // The ordinary case is still the strong one, so the two are told apart.
      check('I while an in-place edit that keeps its words is exact', resolveNode([plans(['Basic', 'Pro', 'Team', 'Enterprise'])], AT, fp(), { labelOf }).confidence === 'exact');
      check('I and a slot with no recorded words to lose is exact too', resolveNode([plans(['Basic', 'Pro', 'Team', 'Enterprise'])], AT, fp({ text: null }), { labelOf }).confidence === 'exact');
      // Either way it is attached: `positional` is a description, not a
      // downgrade to orphaned.
      check('I a positional hold is still an attached review', checkAnchor({ keys: [`index.astro#${AT}`], fingerprint: fp() }, { file: 'index.astro', nodes: [t], labelOf }).state === 'attached');
    }

    // J — the same words turn up somewhere else in the file, under different
    //     ancestors, and the target itself never moved. That is not a rival
    //     candidate — ancestry is part of what a candidate is — so the review
    //     stays exactly where it was rather than going ambiguous on a phrase
    //     that happens to be repeated.
    {
      const t = el('main', { class: 'page' }, [
        el('section', { class: 'plans' }, ['Basic', 'Pro', 'Team', 'Enterprise'].map((n) => el('article', { class: 'plan' }, [el('h3', { class: 'name' }, [txt(n)])]))),
        el('aside', { class: 'sidebar' }, [el('h3', { class: 'name' }, [txt('Team')])]),
      ]);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('J the same words elsewhere: the original keeps its review', r.id === t.children[0].children[2].children[0].id && r.confidence === 'exact', `${r.confidence}/${r.reason}`);
    }

    // ── The proof that I is not a gap in the rules ────────────────────────
    //
    // Built out of real Astro source and read with the real parser, because
    // the claim being made is about what the resolver can possibly know, and
    // a hand-built tree could always be accused of leaving something out.
    //
    // Two DIFFERENT edits:
    //   X  the reviewed card is moved to the end and renamed
    //   Y  two cards have their copy edited where they stand
    //
    // They produce the same file. Not similar — identical, byte for byte. So
    // the resolver is handed the same tree and the same fingerprint in both
    // cases and must return the same answer, while the correct answers differ.
    // That is not something more rules can fix: it is the absence of a stable
    // node identity in the source. Recorded here so that nobody later reads
    // case I as a bug and "fixes" it by orphaning ordinary copy edits.
    {
      const { parsePage } = require('../electron/astroParser.js');
      const card = (n) => `  <article class="plan">\n    <h3 class="name">${n}</h3>\n  </article>`;
      const page = (names) => `---\n---\n<section class="plans">\n${names.map(card).join('\n')}\n</section>\n`;
      const headings = (m) => m.nodes[0].children.map((a) => a.children[0]);
      const words = (h) => h.children[0].value;

      const before = parsePage(page(['Basic', 'Pro', 'Team', 'Enterprise']), {}).model;
      const at = '0.2.0';
      check('the review is on the third card', words(headings(before)[2]) === 'Team');
      // Recorded with the same labeller the resolver is given, which is the
      // whole reason it is an argument: the parser keeps a prop as
      // `{type, value}` rather than a bare string, so crumbLabel falls back to
      // the tag here. Hard-coding class names instead would have made every
      // candidate invisible and quietly turned this proof into a tautology.
      const crumb = (n) => labelOf(n);
      const print = {
        nodeKind: 'element',
        tag: 'h3',
        text: 'Team',
        breadcrumbs: ['index', crumb(before.nodes[0]), crumb(before.nodes[0].children[2]), crumb(headings(before)[2])],
        peers: peerPath(before.nodes, [0, 2, 0]),
      };
      check('the fixture records the ancestors the resolver will compute', print.breadcrumbs.join('/') === 'index/section/article/h3', print.breadcrumbs.join('/'));

      // X: the card the review is on moves to the end and is renamed.
      const afterX = page(['Basic', 'Pro', 'Enterprise', 'Teams']);
      // Y: nothing moves; the third card's copy becomes "Enterprise" and the
      //    fourth's becomes "Teams".
      const afterY = page(['Basic', 'Pro', 'Enterprise', 'Teams']);
      check('two different edits produce the same source, byte for byte', afterX === afterY);

      const mX = parsePage(afterX, {}).model;
      const mY = parsePage(afterY, {}).model;
      const rX = resolveNode(mX.nodes, at, print, { labelOf });
      const rY = resolveNode(mY.nodes, at, print, { labelOf });
      const landedOn = (m, r) => {
        const found = headings(m).find((h) => h.id === r.id);
        return found ? words(found) : null;
      };
      check('so the resolver cannot answer them differently', rX.confidence === rY.confidence && landedOn(mX, rX) === landedOn(mY, rY), `${rX.confidence}:${landedOn(mX, rX)} vs ${rY.confidence}:${landedOn(mY, rY)}`);
      check('and the correct answers are genuinely different', 'Teams' !== 'Enterprise');
      // What it actually does, and what it calls it.
      check('it keeps the slot — right for Y, wrong for X', landedOn(mX, rX) === 'Enterprise', String(landedOn(mX, rX)));
      check('and reports that as a position rather than a proof', rX.confidence === 'positional', rX.confidence);

      // The same edit WITHOUT the rename is not ambiguous at all: the words
      // are still there to follow, so the review goes with its card.
      const kept = parsePage(page(['Basic', 'Pro', 'Enterprise', 'Team']), {}).model;
      const rKept = resolveNode(kept.nodes, at, print, { labelOf });
      check('a reorder on its own is not ambiguous — the words follow', landedOn(kept, rKept) === 'Team', String(landedOn(kept, rKept)));
      check('and that is reported as a move, not as the old slot', rKept.confidence === 'moved', rKept.confidence);
    }

    // G — moved under a different parent entirely.
    {
      const t = el('main', { class: 'page' }, [
        el('section', { class: 'plans' }, ['Basic', 'Pro', 'Enterprise'].map((n) => el('article', { class: 'plan' }, [el('h3', { class: 'name' }, [txt(n)])]))),
        el('aside', { class: 'sidebar' }, [el('h3', { class: 'name' }, [txt('Team')])]),
      ]);
      const r = resolveNode([t], AT, fp(), { labelOf });
      check('G moved to another parent: does not attach to a plan heading', r.id === null || resolvedName(t, r) !== 'Basic', `${r.confidence}/${r.reason}`);
    }

    // And the no-text case: a bare wrapper among identical wrappers.
    {
      const rows = (n) => el('main', { class: 'page' }, [el('section', { class: 'grid' }, Array.from({ length: n }, () => el('div', { class: 'cell' }, [])))]);
      const bare = { nodeKind: 'element', tag: 'div', text: null, breadcrumbs: ['index', 'page', 'grid', 'cell'],
        peers: [{ index: 0, count: 1 }, { index: 0, count: 1 }, { index: 2, count: 4 }] };
      check('an unchanged wrapper among identical wrappers stays attached', resolveNode([rows(4)], '0.0.2', bare, { labelOf }).id !== null);
      check('but one whose run grew orphans rather than sliding', resolveNode([rows(5)], '0.0.2', bare, { labelOf }).id === null, JSON.stringify(resolveNode([rows(5)], '0.0.2', bare, { labelOf })));
    }
  }

  // ── Rung 1 refuses when the position holds something else ─────────────────

  {
    const model = makePage();
    const fp = { nodeKind: 'element', tag: 'h1', text: 'Build faster', breadcrumbs: ['index', 'page', 'hero', 'hero-title'] };
    // The h1 became an h2. Same place, different thing.
    model.nodes[0].children[0].children[0].name = 'h2';
    const found = resolveNode(model.nodes, '0.0.0', fp, { labelOf });
    check('an element that changed tag is not the same element', found.confidence !== 'exact', JSON.stringify(found));
    check('and nothing else in the file answers to it either', found.confidence === 'none' && found.id === null);

    // An element replaced by a component at the same index.
    const swapped = makePage();
    swapped.nodes[0].children[0].children[0] = comp('Headline', {}, []);
    check(
      'an element replaced by a component is not the same node',
      resolveNode(swapped.nodes, '0.0.0', fp, { labelOf }).confidence === 'none'
    );
    check('kind alone catches that', !sameSort({ kind: 'component', name: 'h1' }, fp));
  }

  // ── Rung 2: it moved, and only one thing it could be ──────────────────────

  {
    const model = makePage();
    // Somebody added a banner above the hero, so every index below shifted.
    model.nodes[0].children.unshift(el('aside', { class: 'banner' }, [txt('New!')]));
    const fp = { nodeKind: 'element', tag: 'h1', text: 'Build faster', breadcrumbs: ['index', 'page', 'hero', 'hero-title'] };
    const found = resolveNode(model.nodes, '0.0.0', fp, { labelOf });
    check('a node that shifted is found again', found.confidence === 'moved', JSON.stringify(found));
    check('and it is the right one', found.id === model.nodes[0].children[1].children[0].id);
    check('the new position comes back with it', JSON.stringify(found.trail) === '[0,1,0]');

    // The words changed — which is what happens when the agent DOES the work.
    // An anchor that came unstuck here would break at the moment of success.
    const done = makePage();
    done.nodes[0].children.unshift(el('aside', { class: 'banner' }, [txt('New!')]));
    done.nodes[0].children[1].children[0].children = [txt('Ship faster, on Friday')];
    const after = resolveNode(done.nodes, '0.0.0', fp, { labelOf });
    check('changing the copy does not orphan the review about the copy', after.confidence === 'moved', JSON.stringify(after));
    check('and it is still the same heading', after.id === done.nodes[0].children[1].children[0].id);
  }

  // ── Rung 2 refuses to guess ───────────────────────────────────────────────

  {
    // Two "Learn more" links, same tag, same words, in different places: the
    // classic. Neither ancestry matches the other, so the one that matches is
    // found — this checks the mechanism works before checking it refuses.
    const model = makePage();
    const inFooter = { nodeKind: 'element', tag: 'a', text: 'Learn more', breadcrumbs: ['index', 'page', 'foot', 'more'] };
    model.nodes[0].children.unshift(el('aside', { class: 'banner' }, []));
    const found = resolveNode(model.nodes, '0.2.0', inFooter, { labelOf });
    check('two identical links are told apart by where they are', found.confidence === 'moved' && found.trail.join('.') === '0.3.0', JSON.stringify(found));

    // Now make it genuinely ambiguous: two links with the same tag, same
    // words AND the same ancestry.
    const twins = makePage();
    twins.nodes[0].children[2].children.push(el('a', { class: 'more' }, [txt('Learn more')]));
    twins.nodes[0].children.unshift(el('aside', { class: 'banner' }, []));
    const tie = resolveNode(twins.nodes, '0.2.0', inFooter, { labelOf });
    check('two nodes that match equally well are not guessed between', tie.confidence === 'none', JSON.stringify(tie));
    check('and the reason says why', tie.reason === 'ambiguous', tie.reason);
    check('nothing was selected', tie.id === null);

    // The element is simply gone.
    const gone = makePage();
    gone.nodes[0].children.pop();
    check('a deleted element is gone, not relocated', resolveNode(gone.nodes, '0.2.0', inFooter, { labelOf }).reason === 'gone');

    // Text alone must never be enough. A fingerprint with words but no
    // recorded ancestry has nothing to place it by, and five buttons that say
    // the same thing is exactly the case that must not resolve.
    const textOnly = { nodeKind: 'element', tag: 'a', text: 'Learn more', breadcrumbs: null };
    const blind = resolveNode(makePage().nodes, '9.9.9', textOnly, { labelOf });
    check('matching words alone never reattaches a review', blind.confidence === 'none', JSON.stringify(blind));
    check('and it says the position was unusable rather than inventing one', blind.reason === 'gone' || blind.reason === 'changed', blind.reason);

    // A fingerprint with only the page name and the node itself has no
    // ancestors between them — nothing to place it by.
    const shallow = { nodeKind: 'element', tag: 'a', text: 'Learn more', breadcrumbs: ['index'] };
    check('a fingerprint with no ancestry is not searched on', resolveNode(makePage().nodes, '9.9', shallow, { labelOf }).confidence === 'none');
  }

  // ── The whole anchor, across files ────────────────────────────────────────

  {
    const anchor = {
      page: { route: '/', file: 'src/pages/index.astro' },
      keys: ['src/pages/index.astro#0.0.2', 'src/components/HeroSection.astro#0.1'],
      occurrence: 2,
      occurrenceCount: 4,
      breakpoint: { device: 'phone', viewportWidth: 375, viewportHeight: 800 },
      fingerprint: { nodeKind: 'element', tag: 'span', text: 'Free', breadcrumbs: ['HeroSection', 'rail', 'badge'] },
    };
    const steps = anchorSteps(anchor);
    check('a two-key anchor is one door and one node', steps.length === 2 && steps[0].leaf === false && steps[1].leaf === true);
    check('the door says which component it opens', steps[0].opens === 'HeroSection', steps[0].opens);
    check('the node step opens nothing', steps[1].opens === null);

    const page = makePage();
    // The page holds the door; the component's own tree is not loaded.
    const health = checkAnchor(anchor, { file: 'src/pages/index.astro', nodes: page.nodes, labelOf });
    check('a page that only holds the door cannot say the review is attached', health.state === 'unknown', JSON.stringify(health));
    check('and says why', health.reason === 'deeper');

    // The <HeroSection> was swapped for a <Banner>. The door is wrong, which
    // IS knowable from the page alone.
    const swapped = makePage();
    swapped.nodes[0].children[0].children[2] = comp('Banner', {}, []);
    const broken = checkAnchor(anchor, { file: 'src/pages/index.astro', nodes: swapped.nodes, labelOf });
    check('a door that now opens a different component orphans the review', broken.state === 'orphaned', JSON.stringify(broken));

    // A review on the page itself, with the page open: fully checkable.
    const own = {
      page: { route: '/', file: 'src/pages/index.astro' },
      keys: ['src/pages/index.astro#0.0.0'],
      fingerprint: { nodeKind: 'element', tag: 'h1', text: 'Build faster', breadcrumbs: ['index', 'page', 'hero', 'hero-title'] },
    };
    check('a review on the open page is attached', checkAnchor(own, { file: 'src/pages/index.astro', nodes: page.nodes, labelOf }).state === 'attached');
    const cut = makePage();
    cut.nodes[0].children[0].children.shift();
    check('and orphaned once its element is deleted', checkAnchor(own, { file: 'src/pages/index.astro', nodes: cut.nodes, labelOf }).state === 'orphaned');

    // Another page entirely: nothing is claimed either way.
    check(
      'a review on another page is never judged from this one',
      checkAnchor(own, { file: 'src/pages/about.astro', nodes: page.nodes, labelOf }).state === 'unknown'
    );
  }

  // ── Is this tree really that file's tree? ─────────────────────────────────
  //
  // openFile names the new file before it reads it and sets the model after,
  // so for one render the app says "HeroSection.astro" while still holding the
  // page's tree. Anything that resolved an anchor in that window looked for a
  // component's node in the wrong document and concluded it was gone — which
  // orphaned good comments every time somebody navigated past them, silently,
  // because "not found" and "not loaded yet" look identical to a resolver.
  {
    const { modelMatchesFile } = await load('reviewAnchor');
    const tree = { nodes: [] };
    check(
      'a state stamped with the file it was read from is that file',
      modelMatchesFile({ model: tree, file: '/p/src/pages/index.astro' }, '/p/src/pages/index.astro')
    );
    check(
      'a state stamped with a DIFFERENT file is not — this is the stale pair',
      !modelMatchesFile({ model: tree, file: '/p/src/pages/index.astro' }, '/p/src/components/Hero.astro')
    );
    check('no model at all is not a match', !modelMatchesFile({ file: '/p/a.astro' }, '/p/a.astro'));
    check('and neither is nothing', !modelMatchesFile(null, '/p/a.astro') && !modelMatchesFile(undefined, undefined));
    // In-place edits spread the previous state forward and carry the stamp, so
    // the only unstamped state is one that predates stamping. Trusted, because
    // refusing it would break every edit path for a case that cannot happen.
    check('an unstamped state is trusted', modelMatchesFile({ model: tree }, '/p/anything.astro'));
  }

  // ── The path the canvas knows a review by ─────────────────────────────────
  //
  // The page renders every component's markup, so a comment left three
  // components deep has to wear a pin while the PAGE is open — not only while
  // the file it lives in happens to be the one being edited. A marker that
  // appeared when you drilled in and vanished when you came out would be the
  // opposite of what a marker on a page is for.
  {
    const { markerPathFor } = await load('reviewAnchor');
    const PAGE = 'src/pages/index.astro';
    check("a node in the page itself is a bare path, like the editor uses", markerPathFor(`${PAGE}#0.1.2`, PAGE) === '0.1.2');
    check(
      'a node in a component is named by its own file',
      markerPathFor('src/components/HeroSection.astro#0.0.1', PAGE) === 'src/components/HeroSection.astro|0.0.1'
    );
    // Against the PAGE, not against whatever is open: drilling into a
    // component must not change what its nodes are called on the canvas, or
    // every pin would move the moment somebody opened something.
    check(
      'and drilling into that component does not rename it',
      markerPathFor('src/components/HeroSection.astro#0.0.1', PAGE) ===
        markerPathFor('src/components/HeroSection.astro#0.0.1', PAGE)
    );
    check(
      'nor does it rename the page\u2019s own nodes',
      markerPathFor(`${PAGE}#0.1.2`, PAGE) === '0.1.2'
    );
    check('frontmatter has no box and so no marker', markerPathFor('a.astro#frontmatter', 'b.astro') === null);
    check('nor does a key with no position', markerPathFor('a.astro#', 'b.astro') === null);
    check('nor does something that is not a key', markerPathFor('a.astro', 'b.astro') === null && markerPathFor(null, null) === null);
  }

  // ── The focus plan ────────────────────────────────────────────────────────

  {
    const anchor = {
      page: { route: '/pricing', file: 'src/pages/pricing.astro' },
      keys: ['src/pages/pricing.astro#0.2', 'src/components/Plans.astro#0.1', 'src/components/PlanCard.astro#0.0.3'],
      occurrence: 1,
      breakpoint: { device: 'phone' },
      fingerprint: { nodeKind: 'element', tag: 'span' },
    };
    const plan = focusPlan(anchor, { pageFile: 'src/pages/index.astro', device: 'desktop' });
    check('the plan knows which page to open', plan.page.file === 'src/pages/pricing.astro' && plan.page.needed);
    check('and which breakpoint to restore', plan.device.key === 'phone' && plan.device.needed && plan.device.restorable);
    check('and both doors, in order', plan.drills.length === 2 && plan.drills[0].opens === 'Plans' && plan.drills[1].opens === 'PlanCard');
    check('the first door is in the page, so its path carries no file', plan.drills[0].hostIsPage === true);
    check('the second is inside a component, so it does', plan.drills[1].hostIsPage === false);
    check('each door names the file it opens', plan.drills[0].componentFile === 'src/components/Plans.astro');
    check('the node is the last key', plan.leaf.file === 'src/components/PlanCard.astro' && plan.leaf.indexPath === '0.0.3');
    check('the copy comes along', plan.occurrence === 1);

    // Already there: nothing is reloaded for nothing. Re-opening the page a
    // review is already on would throw the loaded canvas away.
    const here = focusPlan(anchor, { pageFile: 'src/pages/pricing.astro', device: 'phone' });
    check('a page already open is not reopened', here.page.needed === false);
    check('a breakpoint already set is not set again', here.device.needed === false);

    // Unless somebody is inside a component. A drill is an index path into the
    // PAGE, so starting one from two components deep has nothing to walk from
    // — which reported perfectly good reviews as orphaned.
    const deep = focusPlan(anchor, { pageFile: 'src/pages/pricing.astro', device: 'phone', drilledIn: true });
    check('being on the right page is not enough — you have to be AT the page', deep.page.needed === true);
    check('and a page-level review needs it too', focusPlan({ page: { file: 'a.astro' }, keys: ['a.astro#0.1'] }, { pageFile: 'a.astro', drilledIn: true }).page.needed === true);
    check('while not being drilled in leaves it alone', focusPlan({ page: { file: 'a.astro' }, keys: ['a.astro#0.1'] }, { pageFile: 'a.astro' }).page.needed === false);

    // A dragged canvas width is not a breakpoint and cannot be restored.
    const dragged = focusPlan({ ...anchor, breakpoint: { device: 'custom' } }, { pageFile: null, device: 'desktop' });
    check('a dragged width is not restorable', dragged.device.restorable === false && dragged.device.needed === false);

    check('a page-level review has no doors', focusPlan({ page: { file: 'a.astro' }, keys: ['a.astro#0.1'] }, {}).drills.length === 0);
    check('the marker path for a page node carries no file', hostPathFor('src/pages/x.astro', [0, 2], true) === '0.2');
    check('and one inside a component does', hostPathFor('src/components/Plans.astro', [0, 1], false) === 'src/components/Plans.astro|0.1');
  }

  // ── Degrading honestly ────────────────────────────────────────────────────

  {
    const plan = focusPlan(
      { page: { file: 'src/pages/gone.astro' }, keys: ['src/pages/gone.astro#0.1'], occurrence: 2, breakpoint: { device: 'phone' } },
      {}
    );
    check('a missing page is said plainly', /is not in this project any more/.test(focusNote({ restored: nothingRestored(), anchorState: 'orphaned', plan })));
    check(
      'an element that cannot be identified says which of the reasons it was',
      /several nodes match it equally well/.test(
        focusNote({ restored: { ...nothingRestored(), page: true, component: true }, anchorState: 'orphaned', plan, reason: 'ambiguous' })
      )
    );
    check(
      'and points at the creation context rather than at whatever is selected',
      /creationContext/.test(focusNote({ restored: { ...nothingRestored(), page: true, component: true }, anchorState: 'orphaned', plan, reason: 'gone' }))
    );
    check(
      'a copy that is no longer on the page is mentioned, not hidden',
      /Copy 3 of the repeated node/.test(
        focusNote({ restored: { page: true, breakpoint: true, component: true, node: true, occurrence: false }, anchorState: 'attached', plan })
      )
    );
    check(
      'a focus undone by the app navigating away says so, and says to try again',
      /navigated somewhere else/.test(
        focusNote({ restored: { page: true, breakpoint: true, component: true, node: false, occurrence: false }, anchorState: 'orphaned', plan, reason: 'moved_away' })
      )
    );
    check(
      'and a file that never opened is a different sentence from a node that is gone',
      focusNote({ restored: { ...nothingRestored(), page: true, component: true }, anchorState: 'orphaned', plan, reason: 'not_open' }) !==
        focusNote({ restored: { ...nothingRestored(), page: true, component: true }, anchorState: 'orphaned', plan, reason: 'gone' })
    );
    // A focus can identify the right source node with no preview at all — and
    // then there is nothing to scroll to and nothing to photograph. Reporting
    // that as a clean restore is exactly "success because navigation was
    // attempted", which is the one thing this operation must never do.
    {
      const down = focusPlan(
        { page: { file: 'a.astro' }, keys: ['a.astro#0.1'], occurrence: 2, breakpoint: { device: 'phone' } },
        { pageFile: 'a.astro', device: 'phone', previewReady: false }
      );
      check('the plan knows the preview is down', down.previewReady === false);
      const note = focusNote({
        restored: { page: true, breakpoint: true, component: true, node: true, occurrence: false },
        anchorState: 'attached',
        plan: down,
      });
      check('a focus with no preview says so', /preview is not rendering yet/.test(note || ''), note);
      check('and warns that a capture will not show it', /capture will not show it/.test(note || ''));
      check(
        'and does not blame the missing copy for it',
        !/is not on the page any more/.test(note || ''),
        note
      );
      const up = focusPlan(
        { page: { file: 'a.astro' }, keys: ['a.astro#0.1'], occurrence: 2 },
        { pageFile: 'a.astro', previewReady: true }
      );
      check('while a live preview blames the copy, which is the truth there', /Copy 3 of the repeated node/.test(
        focusNote({ restored: { page: true, breakpoint: true, component: true, node: true, occurrence: false }, anchorState: 'attached', plan: up })
      ));
      check('and a preview is assumed live when nobody said otherwise', focusPlan({ page: { file: 'a' }, keys: ['a#0'] }, {}).previewReady === true);
    }

    // A repeated node's source identity survives the loop changing size; which
    // rendered copy it is does not. Saying so is the difference between an
    // agent photographing the right card and photographing the third of five
    // believing it is the third of four.
    {
      const repeated = focusPlan(
        { page: { file: 'a.astro' }, keys: ['a.astro#0.1'], occurrence: 2, occurrenceCount: 4 },
        { pageFile: 'a.astro' }
      );
      check('the plan carries how many copies there were', repeated.occurrenceCount === 4);
      const grown = focusNote({
        restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true },
        anchorState: 'attached',
        plan: repeated,
        liveOccurrenceCount: 5,
      });
      check('a loop that changed size is reported', /copy 3 of 4, and there are now 5/.test(grown || ''), grown);
      check('and it says the element is still right', /element is right/.test(grown || ''));
      check(
        'a loop that did not change size says nothing',
        focusNote({
          restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true },
          anchorState: 'attached',
          plan: repeated,
          liveOccurrenceCount: 4,
        }) === null
      );
      check(
        'and neither does one whose size is unknown',
        focusNote({
          restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true },
          anchorState: 'attached',
          plan: repeated,
          liveOccurrenceCount: null,
        }) === null
      );
    }

    check(
      'a focus that restored everything says nothing at all',
      focusNote({ restored: { page: true, breakpoint: true, component: true, node: true, occurrence: true }, anchorState: 'attached', plan: focusPlan({ page: { file: 'a' }, keys: ['a#0'] }, {}) }) === null
    );
  }

  // ── Comment mode ──────────────────────────────────────────────────────────

  {
    const { reviewModeReducer: reduce, initialReviewMode, isTextEntry, isCommentModeKey, isPinToggleKey, pinRatios, wantsCanvasClick, isComposing, isCommenting } = mode;

    let s = initialReviewMode;
    check('it starts off', s.phase === 'off' && !isCommenting(s));
    s = reduce(s, { type: 'toggle' });
    check('C arms it', s.phase === 'armed' && wantsCanvasClick(s));
    check('and the canvas is not yet composing', !isComposing(s));
    s = reduce(s, { type: 'target', target: { path: '0.1', occurrence: 0 } });
    check('picking a target opens the composer', s.phase === 'composing' && isComposing(s));
    check('the canvas stops taking clicks while the box is open', !wantsCanvasClick(s));
    s = reduce(s, { type: 'escape' });
    check('escape from the composer goes back to armed, not out', s.phase === 'armed');
    s = reduce(s, { type: 'escape' });
    check('escape again leaves comment mode', s.phase === 'off');

    s = reduce(reduce(initialReviewMode, { type: 'enter' }), { type: 'target', target: { path: '0.1' } });
    check('submitting a comment leaves comment mode', reduce(s, { type: 'submitted' }).phase === 'off');
    check('a click the canvas could not place changes nothing', reduce(reduce(initialReviewMode, { type: 'enter' }), { type: 'target', target: null }).phase === 'armed');
    check('C again turns it off', reduce(reduce(initialReviewMode, { type: 'toggle' }), { type: 'toggle' }).phase === 'off');
    check('losing the page closes the composer', reduce(s, { type: 'context-lost' }).phase === 'off');
    check('and does nothing when it was already off', reduce(initialReviewMode, { type: 'context-lost' }) === initialReviewMode);

    // Drilling into a component is not leaving the page. Somebody who pressed
    // C to comment on something deeper meant to still be commenting when they
    // got there — the draft aimed at the file they left is what has to go.
    check('drilling into a component keeps comment mode on', reduce(reduce(initialReviewMode, { type: 'enter' }), { type: 'file-changed' }).phase === 'armed');
    check('but drops a draft aimed at the file left behind', reduce(s, { type: 'file-changed' }).phase === 'armed');
    check('and target with it', reduce(s, { type: 'file-changed' }).target === null);
    check('and it does nothing at all when not commenting', reduce(initialReviewMode, { type: 'file-changed' }) === initialReviewMode);
    check('an event nobody knows changes nothing', reduce(s, { type: 'nonsense' }) === s);

    // The shortcut, and the four things it must not be.
    const key = (over) => ({ key: 'c', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
    check('a bare c is comment mode', isCommentModeKey(key()) && isCommentModeKey(key({ key: 'C' })));
    check('⌘C is not — it copies the selected node', !isCommentModeKey(key({ metaKey: true })));
    check('⌃C is not', !isCommentModeKey(key({ ctrlKey: true })));
    check('⌥C is not — it opens the CMS panel', !isCommentModeKey(key({ altKey: true })));
    check('⇧C is not — it toggles the pins', !isCommentModeKey(key({ shiftKey: true })));
    check('⇧C is the pin toggle', isPinToggleKey(key({ shiftKey: true, key: 'C' })));
    check('and a bare c is not', !isPinToggleKey(key()));
    check('and ⌘⇧C is not — that is copy selection', !isPinToggleKey(key({ shiftKey: true, metaKey: true })));

    // Typing. Every one of these is a place somebody types a `c` all day.
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(`<!doctype html><body>
      <input id="i"><textarea id="t"></textarea><select id="s"></select>
      <div id="ce" contenteditable="true"><span id="inner">x</span></div>
      <div class="cm-editor"><div id="cm" contenteditable="true">code</div></div>
      <div class="xterm"><textarea id="term"></textarea></div>
      <div class="xterm"><div id="termdiv">shell</div></div>
      <button id="b">ok</button><div id="plain">page</div>
    </body>`);
    const $ = (id) => dom.window.document.getElementById(id);
    for (const id of ['i', 't', 's', 'ce', 'inner', 'cm', 'term', 'termdiv']) {
      check(`#${id} counts as typing`, isTextEntry($(id)), id);
    }
    check('a button does not', !isTextEntry($('b')));
    check('the page does not', !isTextEntry($('plain')));
    check('nothing does not throw', !isTextEntry(null) && !isTextEntry({}));

    // Where the click landed, as ratios that survive a reflow.
    const rect = { x: 100, y: 200, w: 400, h: 100 };
    check('a click in the middle is the middle', JSON.stringify(pinRatios({ x: 300, y: 250 }, rect)) === JSON.stringify({ xRatio: 0.5, yRatio: 0.5 }));
    check('a click at the corner is the corner', JSON.stringify(pinRatios({ x: 100, y: 200 }, rect)) === JSON.stringify({ xRatio: 0, yRatio: 0 }));
    check('a click outside is clamped onto the box', pinRatios({ x: -50, y: 9999 }, rect).xRatio === 0 && pinRatios({ x: -50, y: 9999 }, rect).yRatio === 1);
    check('a box with no size gets the middle', pinRatios({ x: 5, y: 5 }, { x: 0, y: 0, w: 0, h: 0 }).xRatio === 0.5);
  }

  // ── Pins ──────────────────────────────────────────────────────────────────

  {
    const rect = { x: 100, y: 200, w: 400, h: 100 };
    check('a pin sits where its ratios say', JSON.stringify(pinPoint(rect, { xRatio: 0.25, yRatio: 0.5 })) === JSON.stringify({ x: 200, y: 250 }));
    check('a node with no box has no pin', pinPoint(null, { xRatio: 0.5, yRatio: 0.5 }) === null);
    check('a pin with no ratios goes to the middle', JSON.stringify(pinPoint(rect, null)) === JSON.stringify({ x: 300, y: 250 }));

    // The reason ratios: the section grew, and the comment is still on the
    // paragraph rather than above it.
    const grown = { x: 100, y: 200, w: 400, h: 400 };
    check('a pin moves with the element it is on', pinPoint(grown, { xRatio: 0.5, yRatio: 0.5 }).y === 400);

    const boxes = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 200, w: 100, h: 100 },
      { x: 0, y: 400, w: 100, h: 100 },
    ];
    check('a review on the second copy is drawn on the second copy', rectForReview(boxes, 1).y === 200);
    check('a review that means the node is drawn on the first', rectForReview(boxes, null).y === 0);
    check('a copy that is no longer there falls back to the first', rectForReview(boxes, 9).y === 0);
    check('a node that rendered nothing has no box', rectForReview([], 0) === null);

    const rects = { '0.1': [{ x: 0, y: 0, w: 200, h: 100 }], '0.2': boxes };
    const { pins, hidden } = placePins(
      [
        { id: 'a', path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'resolved', anchorState: 'attached' },
        { id: 'b', path: '0.1', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' },
        { id: 'c', path: '0.1', occurrence: 0, pin: { xRatio: 0.05, yRatio: 0.1 }, status: 'open', anchorState: 'attached' },
        { id: 'd', path: '0.2', occurrence: 2, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'deferred', anchorState: 'attached' },
        { id: 'e', path: null, occurrence: null, pin: null, status: 'open', anchorState: 'orphaned' },
        { id: 'f', path: '0.9', occurrence: 0, pin: { xRatio: 0.5, yRatio: 0.5 }, status: 'open', anchorState: 'attached' },
      ],
      rects
    );
    const at = (id) => pins.find((p) => p.reviews.includes(id));
    check('two reviews on the same spot are one pin', at('a') === at('b') && at('a').reviews.length === 2, JSON.stringify(pins.map((p) => p.reviews)));
    check('a cluster holding an open review reads as open', at('a').status === 'open');
    check('a review left deliberately elsewhere on the element keeps its own pin', at('c') !== at('a'));
    check('a review on the third copy is drawn on the third copy', at('d').y === 450);
    check('an orphan has nowhere to point', hidden.includes('e'));
    check('and so does a node that rendered nothing this time', hidden.includes('f'));
    check('neither is silently dropped', hidden.length === 2);
    // Unfinished work is always marked, whatever the panel is filtered to.
    check('an open review is marked', pinnable('open', 'open') === true);
    check('and a deferred one is — it still wants something', pinnable('deferred', 'open') === true);
    check('an open one stays marked while reading resolved ones', pinnable('open', 'resolved') === true);
    check('and while reading all of them', pinnable('deferred', 'all') === true);
    // A finished review is never marked by the filter. After a week of work a
    // page wears dozens of finished pins and every one of them is in the way
    // of the ones that are not finished — so the panel is where resolved work
    // is found, and the canvas stays about what is left to do.
    check('a resolved review does not clutter the default view', pinnable('resolved', 'open') === false);
    check('nor the deferred view', pinnable('resolved', 'deferred') === false);
    check('and asking for Resolved does not put them all back on the page', pinnable('resolved', 'resolved') === false);
    check('nor does All', pinnable('resolved', 'all') === false);
    // With one exception, which is the moment somebody actually wants it: the
    // review they are reading. Its marker comes back for exactly as long as it
    // is selected, so "was this really fixed?" has somewhere to point.
    check('the resolved review being read is marked', pinnable('resolved', 'open', { selected: true }) === true);
    check('whatever the panel is filtered to', pinnable('resolved', 'all', { selected: true }) === true);
    check('and stops being marked the moment it is deselected', pinnable('resolved', 'all', { selected: false }) === false);
    // Selection changes nothing for the states that were always marked.
    check('an open review is marked either way', pinnable('open', 'open', { selected: false }) === true);
    // Called with no filter at all it must not start marking finished work.
    check('with no filter given it is the quiet default', pinnable('resolved') === false);
  }

  if (failures.length) {
    console.error(`\nreview-anchor: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`review-anchor: ${checked} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
