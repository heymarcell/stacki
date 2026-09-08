// What `style.set_declarations` is allowed to say it wrote.
//
//   node test/style-batch-atomicity.js
//
// The tool's own summary is "set several properties on one rule in a single
// step", and `applied` is a count of how many it set. There was no behavioural
// test for either sentence, and both were false.
//
// The implementation called setProperty once per declaration, passing
// `live: true` for all but the last so the burst would coalesce into one undo
// step. Each of those calls re-read every style source and then wrote the WHOLE
// document back — and a live write is deliberately NOT committed. So a call
// could read the text from before its predecessor's write, serialize that, and
// write it back, dropping the earlier declaration. Every call returned ok, so
// `applied` counted all of them.
//
// A live dogfood filed it: four declarations onto one rule, two landed, two
// vanished, `applied: 4`. The rule kept `background: #fff` and gained
// `color: #fff` — a button with white text on a white background, from a call
// that reported complete success.
//
// So the checks here are not "did it write something". They are:
//
//   every declaration the call reported is ON DISK;
//   `applied` equals what the file actually holds;
//   they all landed in ONE rule, not scattered;
//   a batch that cannot be written writes NOTHING.
//
// Each reads the real file back through the real main process. Restore the
// per-declaration loop and the first two die.

const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

// How many times `prop` is declared inside the block for `selector`. Counts in
// the ONE rule, so a value that landed in a duplicate rule does not pass.
function declIn(css, selector, prop) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[2]);
  if (blocks.length !== 1) return { rules: blocks.length, hits: 0, value: null };
  const hits = [...blocks[0].matchAll(new RegExp(`(^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g'))];
  return { rules: 1, hits: hits.length, value: hits.length ? hits[hits.length - 1][2].trim() : null };
}

(async () => {
  const root = H.makeProject();
  const app = await H.start(root, { agentMode: 'full' });
  const run = (domain, action, args = {}) => app.api.run(domain, action, args);
  await H.settle(400);

  const CSS = 'src/styles/site.css';

  // ── 1. A batch into a rule that already exists ────────────────────────────
  //
  // `.pricing-grid` is in the fixture with `display` and `gap`. Four
  // declarations go in: two that collide with what is there and two that are
  // new. The collisions are the ones the old loop dropped.

  {
    const page = await run('target', 'read');
    const grid = page.target.children.find((c) => c.label === 'pricing-grid');
    check('the fixture grid is there to style', !!grid, short(page.target.children?.map((c) => c.label)));

    const set = await run('style', 'set_declarations', {
      ref: grid.ref,
      selector: '.pricing-grid',
      source: 'file:src/styles/site.css',
      declarations: [
        { property: 'gap', value: '3rem' },
        { property: 'padding', value: '2rem' },
        { property: 'display', value: 'flex' },
        { property: 'margin', value: '1rem' },
      ],
    });
    check('a four-declaration batch is accepted', set.ok === true, short(set));
    check('and says it applied four', set.applied === 4, short(set));

    await H.settle(300);
    const css = app.read(CSS);

    // THE INVARIANT. Every property the call counted is in the file, in the
    // one rule, with the value that was sent.
    const landed = [
      ['gap', '3rem'],
      ['padding', '2rem'],
      ['display', 'flex'],
      ['margin', '1rem'],
    ];
    for (const [prop, value] of landed) {
      const found = declIn(css, '.pricing-grid', prop);
      check(
        `${prop}: ${value} is on disk after the batch`,
        found.rules === 1 && found.value === value,
        `rules=${found.rules} value=${short(found.value)}\n    ${css}`
      );
    }

    // `applied` is a claim about the file, so it is graded against the file.
    const present = landed.filter(([prop, value]) => declIn(css, '.pricing-grid', prop).value === value).length;
    check('`applied` equals what the file actually holds', set.applied === present, `applied=${set.applied} onDisk=${present}`);

    // One rule, not four. A loop that re-read stale text could also append a
    // second `.pricing-grid` block rather than merge.
    check('they all landed in one rule', declIn(css, '.pricing-grid', 'gap').rules === 1, css);

    // The properties the batch did not name are untouched.
    check('and the rule keeps what nobody wrote to', /--gap/.test(app.read(CSS)), 'the variable it read went missing');
  }

  // ── 2. A batch that creates the rule ──────────────────────────────────────
  //
  // The other path through the function: no identity, a selector and a source,
  // and no such rule yet. The first declaration makes the rule and the rest
  // have to find it rather than start their own.

  {
    const page = await run('target', 'read');
    const grid = page.target.children.find((c) => c.label === 'pricing-grid');
    const set = await run('style', 'set_declarations', {
      ref: grid.ref,
      selector: '.batch-made-this',
      source: 'file:src/styles/site.css',
      declarations: [
        { property: 'color', value: 'rebeccapurple' },
        { property: 'font-weight', value: '700' },
        { property: 'letter-spacing', value: '0.02em' },
      ],
    });
    check('a batch can create the rule it writes into', set.ok === true, short(set));
    check('and reports all three applied', set.applied === 3, short(set));

    await H.settle(300);
    const css = app.read(CSS);
    for (const [prop, value] of [['color', 'rebeccapurple'], ['font-weight', '700'], ['letter-spacing', '0.02em']]) {
      const found = declIn(css, '.batch-made-this', prop);
      check(`${prop} landed in the created rule`, found.rules === 1 && found.value === value, `rules=${found.rules} value=${short(found.value)}`);
    }
    check('the created rule is a single block', declIn(css, '.batch-made-this', 'color').rules === 1, css);
  }

  // ── 3. Nothing half-written ───────────────────────────────────────────────
  //
  // A batch carrying one declaration that cannot be authored must leave the
  // file as it found it, rather than committing the ones before it.

  {
    const before = app.read(CSS);
    const page = await run('target', 'read');
    const grid = page.target.children.find((c) => c.label === 'pricing-grid');
    const set = await run('style', 'set_declarations', {
      ref: grid.ref,
      selector: '.pricing-grid',
      source: 'file:src/styles/site.css',
      declarations: [
        { property: 'outline', value: '2px solid red' },
        { property: 'z-index', value: '' },
      ],
    });
    check('a batch with an unwritable declaration is refused', set.ok === false, short(set));
    await H.settle(300);
    check('and nothing from it reached the file', app.read(CSS) === before, 'the file changed on a refused batch');
    check('not even the declarations before the bad one', !/outline:\s*2px solid red/.test(app.read(CSS)), app.read(CSS));
  }

  // ── 3b. ONE write, which is what makes the race impossible ────────────────
  //
  // Sections 1 and 2 grade the result, and a result can be right by luck: the
  // dropped-declaration race is a timing one, and under jsdom the deferred
  // write often lands before the next read anyway. It reproduced in the
  // packaged app and not here, which is exactly the shape of bug a
  // result-only test lets back in.
  //
  // So this grades the MECHANISM, on the real IPC channel the stylesheet write
  // goes down. N declarations must cost ONE write. A implementation that writes
  // per declaration is re-reading between writes by construction, and that is
  // the race — whether or not this particular run loses a declaration to it.
  {
    const channel = 'style:writeFile';
    const real = app.handlers.get(channel);
    check('the stylesheet write channel is the real one', typeof real === 'function');
    let writes = 0;
    app.handlers.set(channel, (...args) => {
      writes += 1;
      return real(...args);
    });
    try {
      const page = await run('target', 'read');
      const grid = page.target.children.find((c) => c.label === 'pricing-grid');
      const set = await run('style', 'set_declarations', {
        ref: grid.ref,
        selector: '.one-write',
        source: 'file:src/styles/site.css',
        declarations: [
          { property: 'width', value: '10px' },
          { property: 'height', value: '20px' },
          { property: 'min-width', value: '30px' },
          { property: 'max-width', value: '40px' },
          { property: 'min-height', value: '50px' },
        ],
      });
      await H.settle(300);
      check('five declarations are accepted', set.ok === true && set.applied === 5, short(set));
      check('and cost exactly one write to the stylesheet', writes === 1, `writes=${writes} for 5 declarations`);
      const css = app.read(CSS);
      for (const [prop, value] of [['width', '10px'], ['height', '20px'], ['min-width', '30px'], ['max-width', '40px'], ['min-height', '50px']]) {
        check(`${prop} survived the single write`, declIn(css, '.one-write', prop).value === value, css);
      }
    } finally {
      app.handlers.set(channel, real);
    }
  }

  // ── 4. One undo step ──────────────────────────────────────────────────────
  //
  // The reason the old loop used live writes at all. A single write has to keep
  // that promise, not trade it away.

  {
    const page = await run('target', 'read');
    const grid = page.target.children.find((c) => c.label === 'pricing-grid');
    await run('style', 'set_declarations', {
      ref: grid.ref,
      selector: '.undo-batch',
      source: 'file:src/styles/site.css',
      declarations: [
        { property: 'top', value: '1px' },
        { property: 'left', value: '2px' },
        { property: 'right', value: '3px' },
      ],
    });
    await H.settle(300);
    check('the batch is on disk before undo', /\.undo-batch/.test(app.read(CSS)), app.read(CSS));

    const undone = await run('project', 'undo');
    await H.settle(400);
    check('one undo takes the whole batch back', undone.ok && !/right:\s*3px/.test(app.read(CSS)), short(undone) + '\n    ' + app.read(CSS));
  }

  await app.stop?.();
  H.removeProject(root);

  if (failures.length) {
    console.error(`style-batch-atomicity: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`style-batch-atomicity: ${checked} passed  [every declaration counted was read back off disk]`);
})().catch((err) => {
  console.error('style-batch-atomicity: threw', err);
  process.exit(1);
});
