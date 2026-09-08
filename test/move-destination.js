// Where `target.move` puts a node when the caller does not name a parent.
//
//   node test/move-destination.js
//
// `to: { index: 0 }` used to mean THE DOCUMENT ROOT. So a move meant as "put
// this card first in the grid" did not reorder the grid: it lifted the card out
// of the markup entirely and inserted it at the top of the file — in an Astro
// page, above `<!doctype html>`. The envelope said `ok: true` with no note, and
// the card rendered outside <html>, above the site header. A live dogfood
// reproduced it byte-identically twice.
//
// Two sentences are checked here, and they are about the tree rather than the
// envelope:
//
//   an unnamed parent reorders among SIBLINGS and changes nothing else;
//   nothing — however it is asked for — is placed above the doctype.
//
// The root is still a real destination in a component file, which has no
// doctype, and that stays reachable: it is `parentRef: null` now, said rather
// than defaulted into.

const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

(async () => {
  // A PAGE THAT OWNS ITS OWN DOCTYPE.
  //
  // The fixture's index.astro gets <!doctype html> from its layout, so its own
  // root has none and the root is a perfectly legal place to put markup there.
  // The page this defect was found on wrote the document itself — which is the
  // shape that has a doctype at the root of the file being edited, and the only
  // shape where "index 0 of the document" is a position markup must not take.
  const PAGE = 'src/pages/document.astro';
  const root = H.makeProject({
    [PAGE]: `---
const title = 'Document';
---

<!doctype html>
<html lang="en">
  <body>
    <div class="pricing-grid">
      <p>one</p>
    </div>
    <footer>
      <p>{title}</p>
    </footer>
  </body>
</html>
`,
  });
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  const opened = await run('page', 'open', { route: '/document' });
  check('the document-owning page opens', opened.ok === true, short(opened));
  await H.settle(400);

  // A read with no ref describes whatever is SELECTED, and every move below
  // changes the selection. So the body is held once and named explicitly — its
  // children are the siblings the reorder is about.
  const rootRead = await run('target', 'read');
  const htmlNode = rootRead.target?.children?.find((c) => c.label === 'html') || rootRead.target;
  const htmlRead = await run('target', 'read', { ref: htmlNode.ref });
  const bodyRef = htmlRead.target.children.find((c) => c.label === 'body').ref;
  const topLevel = () => run('target', 'read', { ref: bodyRef });

  // ── 1. An unnamed parent reorders among siblings ──────────────────────────
  //
  // The fixture page has a <div class="pricing-grid"> holding a map, and a
  // <footer> after it. Moving the footer to index 0 with no parent named must
  // move it among the nodes it already sits with — not into the file's head.

  {
    const page = await topLevel();
    const before = app.read(PAGE);
    const footer = page.target.children.find((c) => c.label === 'footer');
    check('the fixture has a footer to move', !!footer, short(page.target.children?.map((c) => c.label)));

    const moved = await run('target', 'move', { ref: footer.ref, to: { index: 0 } });
    check('a move with no parent named is accepted', moved.ok === true, short(moved));
    await H.settle(300);

    const after = app.read(PAGE);
    // THE INVARIANT. The footer is still inside the markup, and nothing was
    // put above the doctype.
    const doctypeAt = after.indexOf('<!doctype');
    const footerAt = after.indexOf('<footer');
    check('the page still has its doctype', doctypeAt !== -1, after);
    check('the footer is still in the document, not above the doctype', footerAt > doctypeAt, after);
    check('and it did not land in the frontmatter', !/^---[\s\S]*<footer/m.test(after.split('---')[1] || ''), after);
    // It moved: it is now before the pricing grid rather than after it.
    check('it moved to the front of its own siblings', after.indexOf('<footer') < after.indexOf('pricing-grid'), after);
    check('and the markup still parses as a document', /<html[\s>]/.test(after) && after.indexOf('<html') > doctypeAt, after);

    const undone = await run('project', 'undo');
    await H.settle(300);
    check('and it undoes back to where it was', undone.ok && app.read(PAGE) === before, short(undone));
  }

  // ── 2. Nothing goes above the doctype, even when asked ────────────────────
  //
  // `parentRef: null` is the caller saying the document root on purpose. In a
  // component file that is a real place. In a page it is above the doctype, and
  // that is refused with its cause rather than written.

  {
    const before = app.read(PAGE);
    const page = await topLevel();
    const footer = page.target.children.find((c) => c.label === 'footer');

    const refused = await run('target', 'move', { ref: footer.ref, to: { parentRef: null, index: 0 } });
    check('an explicit root move above the doctype is refused', refused.ok === false, short(refused));
    check('and the refusal names the doctype as the cause', /doctype/i.test(refused.message || ''), short(refused));
    await H.settle(200);
    check('and nothing was written', app.read(PAGE) === before, 'the page changed on a refused move');
  }

  // ── 3. A named parent still reparents ─────────────────────────────────────
  //
  // The capability the default used to cost. Naming a parent moves the node
  // into it, and that has to keep working exactly as it did.

  {
    const page = await topLevel();
    const kids = page.target?.children || [];
    const footer = kids.find((c) => c.label === 'footer');
    const grid = kids.find((c) => c.label === 'pricing-grid');
    // Both are still children of <body>. A move that reparented one of them out
    // of the document loses it here, which is the failure this file is about —
    // named, rather than thrown from a property access.
    check('both nodes are still inside the body', !!footer && !!grid, kids.map((c) => c.label).join(', ') || 'no children');
    if (!footer || !grid) {
      await app.stop?.();
      H.removeProject(root);
      console.error(`move-destination: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
      process.exit(1);
    }

    const moved = await run('target', 'move', { ref: footer.ref, to: { parentRef: grid.ref, index: 0 } });
    check('a move into a named parent is accepted', moved.ok === true, short(moved));
    await H.settle(300);

    const after = app.read(PAGE);
    const gridAt = after.indexOf('pricing-grid');
    const footerAt = after.indexOf('<footer');
    check('and the node is inside that parent now', footerAt > gridAt, after);

    await run('project', 'undo');
    await H.settle(300);
  }

  await app.stop?.();
  H.removeProject(root);

  if (failures.length) {
    console.error(`move-destination: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`move-destination: ${checked} passed  [an unnamed parent reorders; nothing lands above the doctype]`);
})().catch((err) => {
  console.error('move-destination: threw', err);
  process.exit(1);
});
