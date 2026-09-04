// Reading CSS variables out of a stylesheet nobody wrote for an editor.
//
//   node test/css-vars.js [projectDir]
//
// The panel has no schema to go on, so everything it shows is inferred: which
// rules are the same thing in different modes, where one comment stops
// describing the next few lines, and which names are the same property of
// different things. Each of those is a guess that can be wrong in a way that
// makes the panel useless rather than broken — a wall of 317 rows, or a table
// whose columns are `h1-margin` and `h1-trim`.
//
// So the checks are about shape: what the groups are, what the columns are, and
// that every declaration in the file ends up somewhere. The stylesheet used is
// a real one (lumos-framework), and a small synthetic one covers the setups it
// does not have.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const {
  readVariables,
  setVariable,
  setSectionTitle,
  removeSection,
  moveHeading,
  readDeclarations,
  groupRules,
  labelForRule,
} = require('../electron/cssVars.js');

const DEFAULT = path.join(os.homedir(), 'Documents', 'Projects', 'lumos-framework');
const source = path.resolve(process.argv[2] || process.env.STACKI_CSS_FIXTURE || DEFAULT);

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const rowLabels = (block) => block.rows.map((r) => r.label);
const columnLabels = (block, group) =>
  (block.kind === 'matrix' ? block.columns : group.columns).map((c) => c.label);
const findBlock = (group, title) => group.blocks.find((b) => b.title === title);

// Every stylesheet under a project, for reading a declaration back out of the
// source the parse came from.
const cssFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.css')) out.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return out;
};

// --- a stylesheet written by hand, with the shapes the real one lacks -------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-'));
  fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
  const file = path.join(dir, 'src', 'styles', 'tokens.css');
  fs.writeFileSync(
    file,
    `/* tokens */
:root {
  /* Brand */
  --blue: #0af;
  --ink: var(--blue);

  /* Scale */
  --gap-1: 4px;
  --gap-1-min: 4;
  --gap-2: 8px;
  --gap-2-min: 8;
  --gap-3: 12px;
  --gap-3-min: 12;
  --lonely: 1px;
}

@media (min-width: 40rem) {
  :root {
    --gap-1: 6px;
    --gap-2: 10px;
    --gap-3: 14px;
  }
}
`
  );

  const { files } = readVariables(dir);
  check('a stylesheet with variables is found', files.length === 1, JSON.stringify(files.map((f) => f.rel)));
  const groups = files[0].groups;
  check('every declaration is counted', files[0].count === 12, `${files[0].count}`);
  check(
    'a rule inside @media is its own group',
    groups.length === 2,
    groups.map((g) => `${g.label}[${g.columns.map((c) => c.context.join('|')).join()}]`).join(' ')
  );
  const root = groups[0];
  check('comments are section headings', findBlock(root, 'Brand') && findBlock(root, 'Scale'));
  check('a comment section keeps its variables', rowLabels(findBlock(root, 'Brand')).join() === 'blue,ink');
  const scale = root.blocks.find((b) => b.kind === 'matrix');
  check(
    'a numbered scale becomes columns',
    !!scale && columnLabels(scale, root).join() === 'gap-1,gap-2,gap-3',
    JSON.stringify(scale && columnLabels(scale, root))
  );
  check('with a row for the value and one for each part', !!scale && rowLabels(scale).join() === 'value,min');
  check(
    'a name with nothing in common stays a row',
    root.blocks.some((b) => b.kind === 'rows' && rowLabels(b).includes('lonely'))
  );
  const cell = findBlock(root, 'Brand').rows[1].cells[0];
  check('a value that is only a reference says which', cell.ref === '--blue', JSON.stringify(cell));
  check('and resolves through it', cell.color === '#0af', JSON.stringify(cell));

  // Writing one value back.
  const before = fs.readFileSync(file, 'utf8');
  const target = findBlock(root, 'Brand').rows[0].cells[0];
  const written = setVariable(dir, {
    file: target.file,
    valueStart: target.valueStart,
    valueEnd: target.valueEnd,
    expect: target.value,
    value: '#f0a',
  });
  check('a value can be written back', written.ok === true, JSON.stringify(written));
  const after = fs.readFileSync(file, 'utf8');
  check('only that value changed', after === before.replace('#0af;', '#f0a;'), after.slice(0, 200));
  check(
    'and only one line differs',
    before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length === 1
  );
  const stale = setVariable(dir, {
    file: target.file,
    valueStart: target.valueStart,
    valueEnd: target.valueEnd,
    expect: '#0af',
    value: '#000',
  });
  check('a value someone else changed is refused', stale.ok === false && stale.stale === true);

  // Two rules that declare the same names are one thing in two modes.
  fs.writeFileSync(
    path.join(dir, 'src', 'styles', 'theme.css'),
    `.light { --bg: white; --fg: black; }\n.dark { --bg: black; --fg: white; }\n`
  );
  const themed = readVariables(dir).files.find((f) => f.rel.endsWith('theme.css'));
  check('rules with the same names become modes', themed.groups.length === 1 && themed.groups[0].kind === 'modes');
  check('with a column each', themed.groups[0].columns.map((c) => c.label).join() === 'Light,Dark');
  check('and a row per name', rowLabels(themed.groups[0].blocks[0]).join() === 'bg,fg');

  // A stylesheet with no variables is not a tab.
  fs.writeFileSync(path.join(dir, 'src', 'styles', 'plain.css'), 'body { color: red; }\n');
  check(
    'a stylesheet with no variables is left out',
    !readVariables(dir).files.some((f) => f.rel.endsWith('plain.css'))
  );

  // Nested rules (CSS nesting) still report their own selector.
  fs.writeFileSync(
    path.join(dir, 'src', 'styles', 'nested.css'),
    `.card {\n  color: red;\n  &:hover { --lift: 2px; --shadow: 0 2px 4px; }\n}\n`
  );
  const nested = readVariables(dir).files.find((f) => f.rel.endsWith('nested.css'));
  check('a nested rule is found', !!nested && nested.count === 2, JSON.stringify(nested && nested.count));
  check(
    'and remembers what it is nested in',
    nested?.groups[0]?.columns[0]?.context?.includes('.card'),
    JSON.stringify(nested?.groups[0]?.columns[0]?.context)
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- a heading is a comment, and a write to one has to leave it one ---------
//
// A native agent driving the packaged app retitled a section by the range it
// had found in the file — the whole `/* … */` rather than the words inside it,
// which is what `variables` reports. The rename wrote the new title over the
// delimiters, the rule was left holding a bare identifier, and the browser did
// what browsers do with one: it discarded everything up to the next `;`, so the
// declaration UNDER the heading stopped existing. `--theme-transition` computed
// as nothing on the running page, and the operation answered `{ok:true}`.
//
// So the oracle here is not the return value. It is what a CSS engine makes of
// the bytes afterwards: the same custom properties, with the same values.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-heading-'));
  fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
  const rel = 'src/styles/tokens.css';
  const file = path.join(dir, rel);
  // Shaped like the stylesheet it happened in (astro-portfolio's global.css):
  // tab-indented, a heading per run of variables, and a second rule after the
  // first for a runaway cut to reach into.
  const ORIGINAL = `/* Global variables */
:root {
\t/* Fonts */
\t--font-body: "Public Sans", system-ui;
\t--font-brand: Rubik, system-ui;

\t/* Transitions */
\t--theme-transition: 0.2s ease-in-out;
}

:root.theme-dark {
\t--gray-0: #f3f4f7;
\t--gray-50: #e3e6ee;
}
`;
  const write = () => fs.writeFileSync(file, ORIGINAL, 'utf8');
  const read = () => fs.readFileSync(file, 'utf8');

  // What a BROWSER ends up with, not what the text says: a CSS engine's own
  // error recovery is the thing that ate the token, and a parser that stops at
  // the first mistake would never see it happen.
  const asBrowserSeesIt = (css) => {
    const dom = new JSDOM(`<style>${css}</style>`, { virtualConsole: new VirtualConsole() });
    const computed = dom.window.getComputedStyle(dom.window.document.documentElement);
    const out = new Map();
    for (const name of new Set(ORIGINAL.match(/--[\w-]+(?=\s*:)/g) || [])) {
      const value = String(computed.getPropertyValue(name) || '').trim();
      if (value) out.set(name, value);
    }
    dom.window.close();
    return out;
  };
  const sameVariables = (a, b) =>
    a.size === b.size && [...a].every(([name, value]) => b.get(name) === value);
  const declarations = (css) => {
    try {
      return readDeclarations(css).flatMap((r) => r.entries.filter((e) => e.kind === 'var').map((e) => e.name));
    } catch (err) {
      return `unparseable: ${err.message}`;
    }
  };

  write();
  const baseline = asBrowserSeesIt(ORIGINAL);
  check(
    'the fixture starts with three variables the page can read',
    baseline.size === 3 && baseline.get('--theme-transition') === '0.2s ease-in-out',
    JSON.stringify([...baseline])
  );

  // THE DOGFOOD'S CALL: start/end over the whole comment, expect the whole
  // comment — the range an agent gets by finding the heading in the file.
  {
    const start = ORIGINAL.indexOf('/* Transitions */');
    const out = setSectionTitle(dir, {
      file: rel,
      start,
      end: start + '/* Transitions */'.length,
      expect: '/* Transitions */',
      title: 'Motion',
    });
    const after = read();
    check('a heading given as a whole comment is retitled', out.ok === true, JSON.stringify(out));
    check('  and is still a comment afterwards', after.includes('/* Motion */'), after.slice(start - 20, start + 40));
    check('  so the stylesheet still parses', Array.isArray(declarations(after)), String(declarations(after)));
    check(
      '  and the browser still has every variable it had',
      sameVariables(baseline, asBrowserSeesIt(after)),
      JSON.stringify([...asBrowserSeesIt(after)])
    );
    check(
      '  including the one the heading sits above',
      asBrowserSeesIt(after).get('--theme-transition') === '0.2s ease-in-out',
      JSON.stringify(asBrowserSeesIt(after).get('--theme-transition') ?? null)
    );
    check('  and nothing but the heading moved', after === ORIGINAL.replace('/* Transitions */', '/* Motion */'), after);
  }

  // The panel's own range — the words, as `variables` reports them — still
  // renames exactly those words.
  {
    write();
    const block = readVariables(dir)
      .files[0].groups.flatMap((g) => g.blocks)
      .find((b) => b.title === 'Transitions');
    const out = setSectionTitle(dir, {
      file: rel,
      start: block.titleStart,
      end: block.titleEnd,
      expect: 'Transitions',
      title: 'Motion',
    });
    check('the words range still renames', out.ok === true, JSON.stringify(out));
    check('  writing only those words', read() === ORIGINAL.replace('Transitions', 'Motion'), read());
  }

  // A range that is not a heading is refused rather than written blind.
  for (const [what, from, to] of [
    ['a range over a declaration', ORIGINAL.indexOf('--theme-transition'), ORIGINAL.indexOf('--theme-transition') + 18],
    ['a range from one heading past the next', ORIGINAL.indexOf('/* Fonts */'), ORIGINAL.indexOf('/* Transitions */') + 4],
    ['a range at the end of the file', ORIGINAL.length - 2, ORIGINAL.length],
  ]) {
    write();
    const out = setSectionTitle(dir, { file: rel, start: from, end: to, title: 'Motion' });
    check(`${what} is refused`, out.ok === false && typeof out.error === 'string', JSON.stringify(out));
    check(`  and ${what} writes nothing`, read() === ORIGINAL, read());
  }

  // removeSection and moveHeading cut at the same offsets, and used to find
  // their comment by searching backwards for `/*` and forwards for `*/` — which
  // for a whole-comment range started past this comment's end and stopped at
  // the NEXT one, taking every declaration in between.
  {
    write();
    const start = ORIGINAL.indexOf('/* Fonts */');
    const out = removeSection(dir, { file: rel, start, end: start + '/* Fonts */'.length, expect: '/* Fonts */' });
    const after = read();
    check('removing a heading given as a whole comment', out.ok === true, JSON.stringify(out));
    check('  takes the heading line and nothing else', after === ORIGINAL.replace('\t/* Fonts */\n', ''), after);
    check(
      '  so every variable is still on the page',
      sameVariables(baseline, asBrowserSeesIt(after)),
      JSON.stringify([...asBrowserSeesIt(after)])
    );
  }
  {
    write();
    const start = ORIGINAL.indexOf('/* Transitions */');
    const out = moveHeading(dir, {
      file: rel,
      selector: ':root',
      start,
      end: start + '/* Transitions */'.length,
      expect: '/* Transitions */',
      before: '--font-body',
    });
    const after = read();
    check('moving a heading given as a whole comment', out.ok === true, JSON.stringify(out));
    check('  moves it', after.indexOf('/* Transitions */') < after.indexOf('--font-body'), after);
    check(
      '  and leaves every declaration where a browser can still read it',
      sameVariables(baseline, asBrowserSeesIt(after)),
      JSON.stringify([...asBrowserSeesIt(after)])
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the real stylesheet ----------------------------------------------------
if (!fs.existsSync(path.join(source, 'src', 'styles'))) {
  console.log(`css-vars: ${checked} passed (synthetic only — no project at ${source})`);
} else {
  const { files } = readVariables(source);
  const base = files.find((f) => f.rel.endsWith('base.css'));
  check('the token stylesheet is found', !!base);

  const root = base.groups.find((g) => g.label === ':root');
  check(':root is its own group', !!root && root.kind === 'single');

  // The heading scale: one column per heading, one row per property. Found by
  // shape rather than by the comment above it — the heading is the author's
  // text and they are free to rename it, or to put the headings and the text
  // styles under one.
  const headings = root.blocks.find(
    (b) => b.kind === 'matrix' && b.columns.some((c) => c.label === 'h1')
  );
  check('headings become a table', !!headings);
  check(
    'with a column per heading',
    ['display', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].every((h) =>
      columnLabels(headings, root).includes(h)
    ),
    JSON.stringify(headings && columnLabels(headings, root))
  );
  check(
    'and every property as a row',
    ['value', 'min', 'max', 'line-height', 'margin-top', 'trim-bottom', 'text-wrap'].every((r) =>
      rowLabels(headings).includes(r)
    ),
    rowLabels(headings).join()
  );
  check(
    'including the ones a shallower reading would steal',
    rowLabels(headings).includes('margin-top') && rowLabels(headings).includes('trim-top'),
    'margin-top/trim-top were taken by a `top` family instead'
  );

  // The text styles share every one of those properties, so they belong to the
  // same table when they sit under the same comment and their own when they do
  // not — either way they are columns, not thirteen more rows.
  const textStyles = root.blocks.find(
    (b) => b.kind === 'matrix' && b.columns.some((c) => c.label === 'text-main')
  );
  check('text styles are columns too', !!textStyles, JSON.stringify(root.blocks.map((b) => b.title)));
  check(
    'with the same properties down the side',
    textStyles && ['value', 'line-height', 'font-weight'].every((r) => rowLabels(textStyles).includes(r)),
    textStyles && rowLabels(textStyles).join()
  );

  const spacing = root.blocks.find(
    (b) => b.kind === 'matrix' && b.columns.some((c) => c.label === 'space-1')
  );
  check('the spacing scale is a table', !!spacing && columnLabels(spacing, root).length >= 8);
  check('with the fluid pair as rows', !!spacing && rowLabels(spacing).join() === 'value,min,max');

  // The themes: three rules, one table.
  const theme = base.groups.find((g) => g.kind === 'modes' && g.label === 'Theme');
  check('the themes are one group', !!theme);
  check(
    'with a column per theme',
    theme && theme.columns.map((c) => c.label).join() === 'Theme light,Theme dark,Theme brand',
    JSON.stringify(theme && theme.columns.map((c) => c.label))
  );
  check(
    'the light column is named after its class, not :root',
    theme?.columns[0]?.selector?.startsWith(':root'),
    theme?.columns[0]?.selector
  );
  check(
    'shared names are one row across the modes',
    theme && theme.blocks[0].rows.every((r) => r.cells.length === 3 && r.cells.every(Boolean)),
    JSON.stringify(theme && theme.blocks[0].rows.map((r) => r.cells.map((c) => !!c)))
  );
  check(
    'a family of names inside becomes a section',
    theme && ['selection', 'button', 'button-2', 'link'].every((t) => theme.blocks.some((b) => b.title === t)),
    JSON.stringify(theme && theme.blocks.map((b) => b.title))
  );
  check(
    'and button-2 is not six more rows of button',
    theme && findBlock(theme, 'button').rows.length === 6,
    JSON.stringify(theme && rowLabels(findBlock(theme, 'button')))
  );
  check(
    'a background is not a section of one',
    theme && rowLabels(theme.blocks[0]).includes('background-2'),
    JSON.stringify(theme && rowLabels(theme.blocks[0]))
  );

  // Colours resolve through the chain; the ones that cannot say so.
  const themeRows = theme.blocks[0].rows;
  const background = themeRows.find((r) => r.label === 'background');
  // Against the stylesheet itself rather than against a colour written down
  // here: this fixture is a real project someone is working in, and its palette
  // is theirs to change. What is being checked is that the swatch followed the
  // reference — `--background: var(--light-300)` shows what --light-300 IS —
  // and the hex it lands on is the project's business.
  const declaredColor = (name) => {
    for (const f of cssFiles(source)) {
      const text = fs.readFileSync(f, 'utf8');
      const hits = [...text.matchAll(new RegExp(`${name}\\s*:\\s*([^;{}]+);`, 'g'))];
      const last = hits[hits.length - 1];
      if (last && /^#[0-9a-f]{3,8}$/i.test(last[1].trim())) return last[1].trim().toLowerCase();
    }
    return null;
  };
  const through = (cell) => {
    if (!cell?.ref) return null;
    const want = declaredColor(cell.ref);
    return want ? cell.color?.toLowerCase() === want : null;
  };
  check(
    'a swatch resolves through its reference',
    through(background.cells[0]) === true,
    JSON.stringify(background.cells[0])
  );
  check(
    'per mode',
    through(background.cells[1]) === true && through(background.cells[2]) === true,
    JSON.stringify([background.cells[1], background.cells[2]])
  );
  const border = themeRows.find((r) => r.label === 'border');
  check('a colour nothing can compute says so', border.cells[0].unknownColor === true && !border.cells[0].color);

  // The panel resolves values against this map as they are typed (see
  // src/fluid.js), so it has to carry everything a value can reference.
  const { values } = readVariables(source);
  check('every variable is in the resolution map', Object.keys(values).length > 200, `${Object.keys(values).length}`);
  check('with its raw value', values['--viewport-max'] === '1440', values['--viewport-max']);

  // Nothing is lost: every declaration in the file is in some block.
  const declared = readDeclarations(fs.readFileSync(path.join(source, 'src', 'styles', 'base.css'), 'utf8'))
    .flatMap((r) => r.entries.filter((e) => e.kind === 'var').map((e) => e.name));
  const shown = new Set();
  for (const group of base.groups) {
    for (const block of group.blocks) for (const row of block.rows) for (const cell of row.cells) if (cell) shown.add(cell.name);
  }
  const missing = [...new Set(declared)].filter((n) => !shown.has(n));
  check('every variable in the file is shown somewhere', missing.length === 0, missing.slice(0, 8).join(', '));

  // The utility stylesheet: many rules, one variable each, all the same name.
  const utilities = files.find((f) => f.rel.endsWith('utilities.css'));
  if (utilities) {
    const gaps = utilities.groups.find((g) => g.columns.length > 3);
    check('a scale spread over many rules becomes columns', !!gaps, JSON.stringify(utilities.groups.map((g) => g.columns.length)));
    check('with one row', gaps && gaps.blocks[0].rows.length === 1);
  }

  console.log(`css-vars: ${checked - failures.length} passed  [${files.length} stylesheets]`);
}

if (failures.length) {
  console.error(`\ncss-vars: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
