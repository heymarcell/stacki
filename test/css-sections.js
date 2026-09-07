// The four heading operations, against CSS written the way people write it.
//
//   node test/css-sections.js
//
// WHY THIS FILE EXISTS. A live dogfood session, driving a packaged Stacki at
// 8d12c79, produced two site-blanking corruptions from operations that answered
// `ok: true`:
//
//   `style.move_heading` on a heading in `:root` moved `clip-path: inset(50%)`
//   out of `.sr-only` and into `:root`, which applies a 0×0 clip to the whole
//   document. The site rendered blank.
//
//   `style.remove_section` on the same heading deleted 94 of the file's 152
//   lines — `body`, `main`, every heading rule, the `@media` block and
//   `.sr-only` — and left `:root` without its closing brace.
//
// Both had one cause. The heading was located with
//
//     const open  = text.lastIndexOf('/*', start);
//     const close = text.indexOf('*/', end);
//
// and a caller that addresses a heading by its WHOLE comment passes an `end`
// that is already past that comment's own `*/`. So the forward search skipped
// straight over it and stopped at the NEXT one, 117 lines away, inside
// `.sr-only`. Everything between became "the heading".
//
// The candidate replaced that arithmetic with `commentAround`, which walks the
// file from the start, tracks strings, and answers only with a comment that
// actually CONTAINS the given range — and `wordsOf`, which puts a rename back
// inside the delimiters whichever of the two ranges arrived. Those functions
// are correct today. Nothing was asking them to stay correct.
//
// WHAT MAKES THIS A CHECK RATHER THAN A DEMONSTRATION. test/css-vars.js already
// touches three of these operations, but it does it against `lumos-framework`
// in the developer's home directory — absent on CI and on most machines, where
// the whole file skips. So the arithmetic above could be restored tomorrow and
// the deterministic chain would stay green.
//
// Everything here is self-contained: fifteen fixtures written by this file,
// every operation run against every fixture that can take it, and oracles that
// are about BYTES and about the PostCSS tree, not about a return value. The two
// dogfood corruptions are replayed exactly, from the recorded bytes, as their
// own scenarios.
//
// THE ORACLES, and what each one would catch:
//
//   PARSES        the file after the operation is still CSS. Catches a cut that
//                 takes a brace with it — the `remove_section` corruption.
//   ONLY MINE     every rule, selector, declaration and at-rule in the file
//                 except the heading being operated on is byte-identical.
//                 Catches a declaration that travelled — the `move_heading`
//                 corruption — and it catches it even when the result parses.
//   DELIMITED     a heading is `/* … */` afterwards, never a bare word. Catches
//                 the `set_section_title` corruption.
//   FOUND AGAIN   a read after a write rediscovers exactly that section.
//   NO REACH      an operation aimed at a heading in one rule cannot alter
//                 another rule, and specifically cannot alter `.sr-only`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const postcss = require('postcss');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const {
  addSection,
  setSectionTitle,
  removeSection,
  moveHeading,
  readVariables,
} = require('../electron/cssVars.js');

const made = [];
const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-sections-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
  return dir;
};
const cleanup = () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
};

const REL = 'src/styles/x.css';
const write = (dir, css) => {
  fs.writeFileSync(path.join(dir, REL), css, 'utf8');
  return css;
};
const read = (dir) => fs.readFileSync(path.join(dir, REL), 'utf8');

/**
 * The file's structure with every comment removed.
 *
 * This is the oracle that catches a declaration travelling between rules while
 * the file still parses — which is exactly what the `move_heading` corruption
 * did, and exactly what a return value cannot tell you. Comments are stripped
 * because moving one is the whole point of the operation; everything else must
 * be identical afterwards.
 */
function skeleton(css) {
  let root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    return { parsed: false, error: err.message };
  }
  const out = [];
  const walk = (container, depth) => {
    for (const node of container.nodes || []) {
      if (node.type === 'comment') continue;
      if (node.type === 'rule') {
        out.push(`${'  '.repeat(depth)}RULE ${node.selector}`);
        walk(node, depth + 1);
      } else if (node.type === 'atrule') {
        out.push(`${'  '.repeat(depth)}AT @${node.name} ${node.params}`);
        walk(node, depth + 1);
      } else if (node.type === 'decl') {
        out.push(`${'  '.repeat(depth)}DECL ${node.prop}: ${node.value}${node.important ? ' !important' : ''}`);
      }
    }
  };
  walk(root, 0);
  return { parsed: true, text: out.join('\n') };
}

/** Every comment body in the file, in order. */
function comments(css) {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return null;
  }
  const found = [];
  root.walkComments((c) => found.push(c.text));
  return found;
}

/** The bytes of one rule, as they sit in the file. */
function ruleBytes(css, selector) {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return null;
  }
  let found = null;
  root.walkRules((rule) => {
    if (!found && rule.selector === selector) found = css.slice(rule.source.start.offset, rule.source.end.offset + 1);
  });
  return found;
}

/** Where a `/* title *\/` comment's words sit, the way a read reports them. */
function titleRange(css, title) {
  const whole = `/* ${title} */`;
  const at = css.indexOf(whole);
  if (at === -1) return null;
  return { whole: { start: at, end: at + whole.length }, words: { start: at + 3, end: at + 3 + title.length } };
}

// ── the corpus ──────────────────────────────────────────────────────────────
//
// Written out rather than generated, because the shapes are the point: each one
// is a way real CSS is arranged that a boundary calculation could get wrong.

const SR_ONLY = `.sr-only {
	border: 0;
	padding: 0;
	position: absolute !important;
	height: 1px;
	width: 1px;
	overflow: hidden;
	/* IE6, IE7 - a 0 height clip, off to the bottom right of the visible 1px box */
	clip: rect(1px 1px 1px 1px);
	/* maybe deprecated but we need to support legacy browsers */
	clip: rect(1px, 1px, 1px, 1px);
	/* modern browsers, clip-path works inwards from each corner */
	clip-path: inset(50%);
	white-space: nowrap;
}
`;

const FIXTURES = {
  // The dogfood's own arrangement: a heading LAST inside :root, with the whole
  // rest of the stylesheet — and `.sr-only`'s comments — after it. This is the
  // shape that produced both corruptions.
  'heading last in :root, .sr-only below': `:root {
	--accent: #2337ff;
	--gap: 1.25rem;

	/* Dogfood lab tokens */
}
body {
	margin: 0;
	color: #111;
}
${SR_ONLY}`,

  'heading first': `:root {
	/* Colours */
	--accent: #2337ff;
	--ink: #111;
}
`,

  'heading in the middle': `:root {
	--accent: #2337ff;
	/* Spacing */
	--gap: 1rem;
	--pad: 2rem;
}
`,

  'two headings, adjacent': `:root {
	--accent: #2337ff;
	/* Spacing */
	/* Colours */
	--gap: 1rem;
}
`,

  'duplicate heading names in one file': `:root {
	/* Tokens */
	--a: 1px;
}
.card {
	/* Tokens */
	--b: 2px;
}
`,

  'an empty section': `:root {
	--a: 1px;
	/* Nothing under me */
}
`,

  'a section of one variable': `:root {
	/* Alone */
	--only: 1px;
}
`,

  'nested @media after the rule': `:root {
	/* Tokens */
	--gap: 1rem;
}
@media (max-width: 720px) {
	:root {
		--gap: 0.5rem;
	}
	.card {
		padding: 0;
	}
}
`,

  ':root followed by another rule': `:root {
	/* Tokens */
	--gap: 1rem;
}
.card {
	padding: var(--gap);
	color: red;
}
`,

  'CRLF line endings': ':root {\r\n\t/* Tokens */\r\n\t--gap: 1rem;\r\n}\r\n.card {\r\n\tpadding: 0;\r\n}\r\n',

  'space indentation': `:root {
  /* Tokens */
  --gap: 1rem;
}
`,

  'a Unicode heading': `:root {
	/* Színek és méretek — 色 */
	--accent: #2337ff;
}
`,

  'a heading full of punctuation': `:root {
	/* Tokens (v2): sizes, colours & "edges" */
	--accent: #2337ff;
}
`,

  'comments between ordinary declarations': `.card {
	color: red;
	/* Layout */
	display: grid;
	/* why: the grid needs a gap */
	gap: 1rem;
}
`,

  'two :root-like selectors': `:root {
	/* Tokens */
	--gap: 1rem;
}
:root[data-theme='dark'] {
	/* Tokens */
	--gap: 2rem;
}
`,
};

// ── the matrix ──────────────────────────────────────────────────────────────

for (const [label, css] of Object.entries(FIXTURES)) {
  const before = skeleton(css);
  if (!check(`[${label}] the fixture itself is CSS`, before.parsed, before.error)) continue;

  const headings = (comments(css) || []).map((c) => c.trim());
  const heading = headings[0];
  if (!heading) {
    check(`[${label}] the fixture has a heading to operate on`, false);
    continue;
  }
  const range = titleRange(css, heading);
  if (!range) {
    check(`[${label}] the heading is spelled the way the fixtures say`, false, JSON.stringify(headings));
    continue;
  }

  // BOTH RANGES, EVERY TIME. `style.variables` reports where the WORDS are;
  // an agent that found the heading in the file passes the WHOLE comment. Four
  // bytes apart on each side, and telling them apart is precisely what the old
  // arithmetic could not do — so every operation is asked in both spellings.
  for (const [spelling, at] of [['words', range.words], ['whole comment', range.whole]]) {
    const tag = `[${label}] (${spelling})`;

    // ── set_section_title ──────────────────────────────────────────────────
    {
      const dir = project();
      write(dir, css);
      const out = setSectionTitle(dir, {
        file: REL,
        start: at.start,
        end: at.end,
        expect: css.slice(at.start, at.end),
        title: 'Renamed',
      });
      const after = read(dir);
      check(`${tag} rename answers ok`, out.ok === true, JSON.stringify(out));
      const shape = skeleton(after);
      check(`${tag} rename leaves CSS that parses`, shape.parsed, shape.error);
      // THE D07 ORACLE. Writing over the delimiters left `Renamed` as a bare
      // word in the rule; the browser then discarded everything up to the next
      // `;`, taking the declaration under it with it. `ok` was still true.
      check(
        `${tag} rename keeps the comment delimiters`,
        /\/\*[^*]*Renamed[^*]*\*\//.test(after),
        after.split('\n').find((l) => l.includes('Renamed')) || after.slice(0, 120)
      );
      check(`${tag} rename does not leave the old name`, !after.includes(`/* ${heading} */`) || headings.filter((h) => h === heading).length > 1);
      // ONLY THE COMMENT MOVED.
      check(`${tag} rename changes no rule, declaration or at-rule`, shape.parsed && shape.text === before.text, `${before.text}\n    ---\n    ${shape.text}`);
      // FOUND AGAIN.
      const reread = comments(after) || [];
      check(`${tag} rename is discoverable afterwards`, reread.some((c) => c.trim() === 'Renamed'), JSON.stringify(reread));
    }

    // ── move_heading ───────────────────────────────────────────────────────
    //
    // Only meaningful where the heading's rule has a declaration to sit above.
    {
      const root = postcss.parse(css);
      let owner = null;
      root.walkComments((c) => {
        if (!owner && c.text.trim() === heading && c.parent.type === 'rule') owner = c.parent;
      });
      const decls = owner ? (owner.nodes || []).filter((n) => n.type === 'decl') : [];
      if (owner && decls.length) {
        const dir = project();
        write(dir, css);
        const out = moveHeading(dir, {
          file: REL,
          selector: owner.selector,
          start: at.start,
          end: at.end,
          expect: css.slice(at.start, at.end),
          before: decls[0].prop,
        });
        const after = read(dir);
        check(`${tag} move answers ok`, out.ok === true, JSON.stringify(out));
        const shape = skeleton(after);
        check(`${tag} move leaves CSS that parses`, shape.parsed, shape.error);
        // THE D06 ORACLE, and the one that matters most. The corruption moved
        // `clip-path: inset(50%)` from `.sr-only` into `:root` and blanked the
        // site — while producing a file that parses perfectly well. Only a
        // comparison of the whole structure sees it.
        check(
          `${tag} move carries no declaration with it`,
          shape.parsed && shape.text === before.text,
          `${before.text}\n    --- became ---\n    ${shape.text}`
        );
        check(`${tag} move keeps every comment`, JSON.stringify((comments(after) || []).map((c) => c.trim()).sort()) === JSON.stringify(headings.slice().sort()), JSON.stringify(comments(after)));
        if (css.includes('.sr-only')) {
          check(`${tag} move leaves .sr-only byte-identical`, ruleBytes(after, '.sr-only') === ruleBytes(css, '.sr-only'), String(ruleBytes(after, '.sr-only')).slice(0, 200));
        }
      }
    }

    // ── remove_section ─────────────────────────────────────────────────────
    {
      const dir = project();
      write(dir, css);
      const out = removeSection(dir, {
        file: REL,
        start: at.start,
        end: at.end,
        expect: css.slice(at.start, at.end),
      });
      const after = read(dir);
      check(`${tag} remove answers ok`, out.ok === true, JSON.stringify(out));
      const shape = skeleton(after);
      check(`${tag} remove leaves CSS that parses`, shape.parsed, shape.error);
      // THE D14 ORACLE. Removing a heading takes the heading. The variables
      // under it join the section above — that is what a heading meant.
      check(
        `${tag} remove takes no declaration with it`,
        shape.parsed && shape.text === before.text,
        `${before.text}\n    --- became ---\n    ${shape.text}`
      );
      const left = (comments(after) || []).map((c) => c.trim());
      check(`${tag} remove takes exactly one comment`, left.length === headings.length - 1, `${JSON.stringify(headings)} -> ${JSON.stringify(left)}`);
      if (css.includes('.sr-only')) {
        check(`${tag} remove leaves .sr-only byte-identical`, ruleBytes(after, '.sr-only') === ruleBytes(css, '.sr-only'));
      }
      // The line endings the file was written with survive.
      if (css.includes('\r\n')) check(`${tag} remove keeps CRLF`, after.includes('\r\n') && !/[^\r]\n/.test(after), JSON.stringify(after.slice(0, 80)));
    }
  }

  // ── add_section ───────────────────────────────────────────────────────────
  {
    const root = postcss.parse(css);
    let owner = null;
    root.walkRules((rule) => {
      if (!owner && (rule.nodes || []).some((n) => n.type === 'decl')) owner = rule;
    });
    if (owner) {
      const dir = project();
      write(dir, css);
      const decls = (owner.nodes || []).filter((n) => n.type === 'decl');
      const out = addSection(dir, { file: REL, selector: owner.selector, title: 'Brand new', before: decls[0].prop });
      const after = read(dir);
      check(`[${label}] add answers ok`, out.ok === true, JSON.stringify(out));
      const shape = skeleton(after);
      check(`[${label}] add leaves CSS that parses`, shape.parsed, shape.error);
      check(`[${label}] add changes no rule or declaration`, shape.parsed && shape.text === before.text, `${before.text}\n    ---\n    ${shape.text}`);
      check(`[${label}] add writes a delimited comment`, /\/\* Brand new \*\//.test(after), after.slice(0, 200));
      const now = (comments(after) || []).map((c) => c.trim());
      check(`[${label}] add adds exactly one comment`, now.length === headings.length + 1, JSON.stringify(now));
      // Indentation is taken from the line it lands on, not from a constant.
      const line = after.split('\n').find((l) => l.includes('Brand new')) || '';
      const anchorLine = after.split('\n').find((l) => l.includes(`${decls[0].prop}:`)) || '';
      check(
        `[${label}] add takes the indentation of the line it lands on`,
        (line.match(/^[\t ]*/) || [''])[0] === (anchorLine.match(/^[\t ]*/) || [''])[0],
        `${JSON.stringify(line)} vs ${JSON.stringify(anchorLine)}`
      );
    }
  }
}

// ── the refusals ────────────────────────────────────────────────────────────
//
// A range that is not a heading has to be refused, because the alternative is
// what the old code did: treat any pair of offsets as a comment and cut between
// them.

{
  const css = FIXTURES['heading last in :root, .sr-only below'];
  const at = css.indexOf('--accent');

  for (const [name, op] of [
    ['rename', (dir, args) => setSectionTitle(dir, { ...args, title: 'Nope' })],
    ['remove', (dir, args) => removeSection(dir, args)],
    ['move', (dir, args) => moveHeading(dir, { ...args, selector: ':root', before: '--accent' })],
  ]) {
    const dir = project();
    write(dir, css);
    const out = op(dir, { file: REL, start: at, end: at + 8, expect: css.slice(at, at + 8) });
    check(`${name} refuses a range that is not a comment`, out.ok === false, JSON.stringify(out));
    check(`${name} says what a heading is`, /heading/i.test(String(out.error || '')), String(out.error));
    check(`${name} changes nothing when it refuses`, read(dir) === css);
  }

  // A range spanning FROM inside one comment TO inside a later one is the exact
  // shape the old arithmetic accepted and cut across.
  {
    const from = css.indexOf('/* Dogfood lab tokens */');
    const to = css.indexOf('clip-path: inset(50%)');
    const dir = project();
    write(dir, css);
    const out = removeSection(dir, { file: REL, start: from, end: to });
    check('a range straddling two comments is refused', out.ok === false, JSON.stringify(out));
    check('and nothing is cut', read(dir) === css);
  }

  // Stale: the file moved since the read.
  {
    const dir = project();
    write(dir, css);
    const range = titleRange(css, 'Dogfood lab tokens');
    const out = setSectionTitle(dir, { file: REL, start: range.words.start, end: range.words.end, expect: 'Something else entirely', title: 'X' });
    check('a rename whose expectation does not match is refused', out.ok === false && out.stale === true, JSON.stringify(out));
    check('and the file is untouched', read(dir) === css);
  }

  // A title that would close the comment early takes the rest of the rule with
  // it. Refused, in both operations that write one.
  {
    const dir = project();
    write(dir, css);
    const range = titleRange(css, 'Dogfood lab tokens');
    const renamed = setSectionTitle(dir, { file: REL, start: range.words.start, end: range.words.end, title: 'Bad */ .evil { color: red } /*' });
    check('a title containing */ is refused', renamed.ok === false, JSON.stringify(renamed));
    check('and the file is untouched', read(dir) === css);
    const added = addSection(dir, { file: REL, selector: ':root', title: 'Bad */ x', before: '--accent' });
    check('and a new section cannot smuggle one in either', added.ok === false, JSON.stringify(added));
    check('and that file is untouched too', read(dir) === css);
  }
}

// ── the two corruptions, replayed from the recorded bytes ───────────────────
//
// The dogfood's own stylesheet, its own offsets, and the two files the shipped
// build actually wrote. These are not paraphrases: `EVIDENCE` holds the exact
// arguments that produced them.

{
  const DOGFOOD = `:root {
	--accent: #2337ff;
	--dogfood-accent: var(--accent);
	--dogfood-surface: #ffffff;
	--dogfood-gap: 1.25rem;

	/* Dogfood lab tokens */
}
body {
	font-family: var(--font-atkinson);
	margin: 0;
	color: rgb(var(--gray-dark));
}
main {
	width: 720px;
	margin: auto;
}
@media (max-width: 720px) {
	body {
		font-size: 18px;
	}
	main {
		padding: 1em;
	}
}
${SR_ONLY}`;

  const before = skeleton(DOGFOOD);
  const range = titleRange(DOGFOOD, 'Dogfood lab tokens');
  // The whole-comment spelling — the one that broke it.
  const args = { file: REL, start: range.whole.start, end: range.whole.end, expect: '/* Dogfood lab tokens */' };

  {
    const dir = project();
    write(dir, DOGFOOD);
    const out = moveHeading(dir, { ...args, selector: ':root', before: '--accent' });
    const after = read(dir);
    check('the dogfood move answers ok', out.ok === true, JSON.stringify(out));
    // THE SENTENCE THE WHOLE FILE IS FOR.
    check(
      'moving a heading in :root cannot put clip-path on :root',
      !/:root\s*\{[^}]*clip-path/.test(after),
      after.slice(0, 400)
    );
    check('and .sr-only keeps its clip-path', /\.sr-only\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(after), String(ruleBytes(after, '.sr-only')).slice(0, 200));
    check('and .sr-only is byte-identical', ruleBytes(after, '.sr-only') === ruleBytes(DOGFOOD, '.sr-only'));
    const shape = skeleton(after);
    check('and nothing but the comment moved', shape.parsed && shape.text === before.text, `${before.text}\n    ---\n    ${shape.text}`);
    check('and the @media block is untouched', after.includes('@media (max-width: 720px)') && /@media[^{]*\{[\s\S]*?font-size: 18px/.test(after));
  }

  {
    const dir = project();
    write(dir, DOGFOOD);
    const out = removeSection(dir, args);
    const after = read(dir);
    check('the dogfood remove answers ok', out.ok === true, JSON.stringify(out));
    const lost = DOGFOOD.split('\n').length - after.split('\n').length;
    check('removing that heading removes ONE line', lost === 1, `removed ${lost} lines`);
    check('body survives', /(^|\n)body\s*\{/.test(after));
    check('main survives', /(^|\n)main\s*\{/.test(after));
    check('the @media block survives', after.includes('@media (max-width: 720px)'));
    check('.sr-only survives byte-identically', ruleBytes(after, '.sr-only') === ruleBytes(DOGFOOD, '.sr-only'));
    check('every brace is still balanced', (after.match(/\{/g) || []).length === (after.match(/\}/g) || []).length, `${(after.match(/\{/g) || []).length} open, ${(after.match(/\}/g) || []).length} close`);
    const shape = skeleton(after);
    check('and no declaration went with it', shape.parsed && shape.text === before.text, `${before.text}\n    ---\n    ${shape.text}`);
  }

  // The read path finds what the write path left, which is what makes the loop
  // usable: rename, then find the section under its new name.
  {
    const dir = project();
    write(dir, DOGFOOD);
    const renamed = setSectionTitle(dir, { ...args, title: 'Lab tokens' });
    check('the dogfood rename answers ok', renamed.ok === true, JSON.stringify(renamed));
    const after = read(dir);
    check('and writes a delimited comment', after.includes('/* Lab tokens */'), after.split('\n').find((l) => l.includes('Lab tokens')));
    const vars = readVariables(dir);
    const titles = [];
    for (const file of vars.files || []) for (const group of file.groups || []) for (const block of group.blocks || []) if (block.title) titles.push(block.title);
    check('and the variables read finds the section under its new name', titles.some((t) => /Lab tokens/i.test(t)), JSON.stringify(titles));
    // AND IT REPORTS THE WORDS, WHICH IS THE OTHER HALF OF THE TWO-SPELLING
    // PROBLEM. A caller that passes these offsets back is passing the inner
    // range; a caller that found the heading itself passes the whole comment.
    // Both spellings are exercised above precisely because the read only ever
    // hands out one of them.
    let found = null;
    for (const file of vars.files || []) for (const group of file.groups || []) for (const block of group.blocks || []) if (block.title === 'Lab tokens') found = block;
    check(
      'and the offsets it reports are the words, not the delimiters',
      found && after.slice(found.titleStart, found.titleEnd) === 'Lab tokens',
      found ? JSON.stringify(after.slice(found.titleStart, found.titleEnd)) : 'no block'
    );
  }
}

cleanup();

if (failures.length) {
  console.error(`\ncss-sections: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`css-sections: ${checked} passed  [four heading operations, fifteen shapes, both dogfood corruptions]`);
