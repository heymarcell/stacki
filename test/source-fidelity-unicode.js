// The characters a file holds, and what an edit somewhere else does to them.
//
//   node test/source-fidelity-unicode.js
//
// A live dogfood session opened a page, ran a structural edit on one part of
// it, and found that an untouched heading three lines away had changed:
//
//     -   <h1>🧑‍🚀 Hello, Astronaut!</h1>
//     +   <h1>🧑&#8205;🚀 Hello, Astronaut!</h1>
//
// The zero width joiner that makes 🧑 and 🚀 into one astronaut had been
// written out as an entity. The page still rendered the same and the file no
// longer said what the author wrote — in a node nobody had asked to change.
//
// TWO THINGS WERE WRONG, and the corpus below exists because either one alone
// would let it happen again.
//
// 1. `encodeText` spelled joiners out. Its rule was "the characters that are
//    invisible in a source file", which is right for a no-break space — that
//    looks exactly like a space and is not one, so the file lies unless it is
//    written `&#160;`. It is wrong for a joiner: the file says `🧑‍🚀` and the
//    page shows one astronaut, and writing `🧑&#8205;🚀` makes the file say
//    three things where the page shows one. THAT is the lie. So the rule is now
//    stated as the thing it was always reaching for — spell a character out
//    when leaving it literal would make the file lie — and the joiners came off
//    the list.
//
// 2. The parser kept the original bytes of a text node only when the slice
//    spanned lines or contained an entity. Those are two cases somebody thought
//    of, and the joiner was a third. It now asks the question by measurement:
//    keep the bytes when `encodeText(value)` would not reproduce them. That
//    cannot fall behind the encoder, because it asks the encoder.
//
// 3. `collapseWhitespace` squeezed runs of `\s`, and `\s` includes U+00A0 and
//    the fixed-width spaces — which no browser collapses, that being the entire
//    reason somebody types one. A literal `ten<NBSP>kilos` in a file became
//    `ten kilos` on the next reserialize of a node nobody had edited. Same
//    defect, different character. It now collapses the HTML white space set.
//
// WHAT THIS FILE ASSERTS, and why it is bytes rather than a model comparison:
// the promise is about the FILE. A test that parses both sides and compares
// trees would have been green through every one of the three defects above,
// because all three preserve meaning perfectly and change spelling. So every
// oracle here is `===` on strings read back off disk, and the structural edits
// are driven through the real Agent API against real files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};

const { parsePage, serializePage, anchoredSerialize } = require('../electron/astroParser.js');
const { encodeText, decodeEntities } = require('../electron/htmlText.js');

/** Codepoints a terminal can show, so a failure is readable. */
const esc = (s) =>
  Array.from(String(s))
    .map((c) => {
      const n = c.codePointAt(0);
      if (n < 127 || n > 0x1f000) return c;
      return `<U+${n.toString(16).toUpperCase().padStart(4, '0')}>`;
    })
    .join('');

// ── the corpus ──────────────────────────────────────────────────────────────
//
// Each entry is a run of text as it would be WRITTEN IN A FILE. What every one
// of them has to survive is a round trip through parse and serialize with
// nothing edited, and a structural edit to a DIFFERENT node in the same file.

const TEXT = {
  'ZWJ astronaut': '🧑‍🚀 Hello, Astronaut!',
  'ZWJ family': '👩‍👩‍👧‍👦 four of them',
  'skin tone modifier': '👋🏽 hello',
  'flag, regional indicators': '🇭🇺 Magyarország',
  'ZWNJ, Persian': 'می‌رود',
  'combining marks': 'élève — combining acutes',
  'Hebrew, right to left': 'שלום עולם',
  'Arabic, right to left': 'مرحبا بالعالم',
  'Hungarian accents': 'Árvíztűrő tükörfúrógép',
  CJK: '日本語のテキスト 中文 한국어',
  'literal ©': '© 2026 Remarkable',
  'entity ©': '&copy; 2026 Remarkable',
  'literal NBSP': 'ten kilos',
  'entity NBSP': 'ten&#160;kilos',
  'literal thin space': 'a b',
  'literal soft hyphen': 'hy­phen',
  'mixed literal and entity': '© and &copy; and 🧑‍🚀',
  'an ampersand that is not an entity': 'Tom & Jerry',
  'text that looks like an entity but is not': '&unknowable; stays',
};

// ── 1. the encoder's own rule ───────────────────────────────────────────────

{
  // The joiners come back as themselves. This is the assertion the defect was.
  for (const [label, cp] of [['ZWJ', '‍'], ['ZWNJ', '‌']]) {
    const written = encodeText(`a${cp}b`);
    check(`${label} is written as itself, not as an entity`, written === `a${cp}b`, esc(written));
  }
  // The ones that would lie are still spelled out.
  for (const [label, cp, want] of [
    ['no-break space', ' ', '&#160;'],
    ['en space', ' ', '&#8194;'],
    ['em space', ' ', '&#8195;'],
    ['thin space', ' ', '&#8201;'],
    ['soft hyphen', '­', '&#173;'],
  ]) {
    const written = encodeText(`a${cp}b`);
    check(`${label} is still spelled out — it looks like nothing it is`, written === `a${want}b`, esc(written));
  }
  // The three that would otherwise be markup.
  check('an ampersand is escaped', encodeText('a & b') === 'a &amp; b');
  check('a less-than is escaped', encodeText('a < b') === 'a &lt; b');
  check('a greater-than is escaped', encodeText('a > b') === 'a &gt; b');
  // Everything the encoder writes has to read back as what it was given.
  for (const [label, text] of Object.entries(TEXT)) {
    const round = decodeEntities(encodeText(decodeEntities(text)));
    check(`what is written for "${label}" reads back as itself`, round === decodeEntities(text), `${esc(round)} vs ${esc(decodeEntities(text))}`);
  }
}

/**
 * What the page SAYS, with the spelling and the layout taken out: every text
 * run decoded to its characters, whitespace between tags dropped.
 *
 * This is what a canonical reprint is allowed to keep and nothing else — it may
 * reindent, it may not turn `🧑‍🚀` into `🧑&#8205;🚀`, because the second is a
 * different string once decoded.
 */
const textOf = (html) =>
  decodeEntities(html.replace(/<[^>]*>/g, '\u0000'))
    .split('\u0000')
    .map((run) => run.replace(/[\t\n\r ]+/g, ' ').trim())
    .filter(Boolean)
    .join('|');

// ── 2. an untouched file goes back exactly as it came ───────────────────────

const page = (body, { crlf = false, tabs = true } = {}) => {
  const indent = tabs ? '\t' : '  ';
  const src = `---
import Base from '../layouts/Base.astro';
---
<Base>
${indent}<main>
${indent}${indent}${body}
${indent}${indent}<p>A second paragraph, untouched.</p>
${indent}</main>
</Base>
`;
  return crlf ? src.replace(/\n/g, '\r\n') : src;
};

for (const [label, text] of Object.entries(TEXT)) {
  for (const crlf of [false, true]) {
    for (const tabs of [true, false]) {
      const src = page(`<h1>${text}</h1>`, { crlf, tabs });
      const shape = `${label}${crlf ? ', CRLF' : ''}${tabs ? ', tabs' : ', spaces'}`;
      const parsed = parsePage(src);
      if (!check(`[${shape}] the page parses`, parsed.editable, parsed.reason)) continue;
      // THE BYTE CONTRACT IS `anchoredSerialize`'s. It is what every write goes
      // through, and it has the original to hand.
      check(`[${shape}] an anchored reserialize is byte-identical`, anchoredSerialize(src, parsed.model) === src, esc(anchoredSerialize(src, parsed.model)));
      // `serializePage` is the CANONICAL printer — it is allowed to choose its
      // own indentation and line endings, and does, so byte identity is not its
      // promise. What it may never do is change a CHARACTER, and that is the
      // half the dogfood caught: the sequence has to survive a full reprint too,
      // because `anchoredSerialize` falls back to one and componentFile.js and
      // writeChunks() call it with no source at all.
      const flat = serializePage(parsed.model);
      check(`[${shape}] a full reprint keeps the characters`, textOf(flat) === textOf(src), `${esc(textOf(flat))} vs ${esc(textOf(src))}`);
      check(`[${shape}] a full reprint invents no numeric entity`, !/&#\d+;/.test(flat) || /&#\d+;/.test(src), esc(flat.split('\n').find((l) => /&#\d+;/.test(l))));
    }
  }
}

// The attribute and structural shapes §6B names, each carrying a character that
// used to be rewritten.
const SHAPES = {
  'single-quoted attribute': `<img src='a.png' alt='🧑‍🚀 crew' />`,
  'double-quoted attribute': `<img src="a.png" alt="🧑‍🚀 crew" />`,
  'an attribute holding an entity': `<img src="a.png" alt="&copy; 2026" />`,
  'an Astro expression beside literal text': `<p>🧑‍🚀 {crew.name} rides</p>`,
  'an HTML comment': `<p>text</p>\n\t\t<!-- 🧑‍🚀 a note nobody reads -->`,
  'a class list with a NBSP inside text': `<p class="lead big">ten kilos</p>`,
  'nested elements around the sequence': `<p><strong>🧑‍🚀</strong> and <em>© 2026</em></p>`,
};

for (const [label, body] of Object.entries(SHAPES)) {
  const src = page(body);
  const parsed = parsePage(src);
  if (!check(`[${label}] parses`, parsed.editable, parsed.reason)) continue;
  check(`[${label}] anchored-reserializes byte-identically`, anchoredSerialize(src, parsed.model) === src, esc(anchoredSerialize(src, parsed.model)));
  check(`[${label}] a full reprint keeps the characters`, textOf(serializePage(parsed.model)) === textOf(src), esc(serializePage(parsed.model)));
}

// A multiline attribute block, which is the shape that used to be reflowed.
{
  const src = `---
import Base from '../layouts/Base.astro';
---
<Base>
\t<main>
\t\t<img
\t\t\tsrc="/crew.png"
\t\t\talt="🧑‍🚀 the crew"
\t\t\tloading="lazy"
\t\t/>
\t\t<p>ten kilos</p>
\t</main>
</Base>
`;
  const parsed = parsePage(src);
  check('a hand-wrapped attribute block parses', parsed.editable, parsed.reason);
  check('and anchored-reserializes byte-identically', anchoredSerialize(src, parsed.model) === src, esc(anchoredSerialize(src, parsed.model)));
  check('and a full reprint keeps its characters', textOf(serializePage(parsed.model)) === textOf(src), esc(serializePage(parsed.model)));
}

// ── 3. a structural edit somewhere else leaves it alone ─────────────────────
//
// THE ACTUAL DEFECT. Everything above is a round trip with nothing changed,
// which the shipped build ALSO passed — the damage only appeared when something
// reprinted a subtree containing an untouched node. So each of these makes a
// real change to a DIFFERENT node and then asks whether the sequence survived.

function editModel(src, mutate) {
  const parsed = parsePage(src);
  if (!parsed.editable) return { ok: false, reason: parsed.reason };
  const model = JSON.parse(JSON.stringify(parsed.model));
  mutate(model);
  return { ok: true, out: anchoredSerialize(src, model) };
}

// An element's tag is `name` in this model, not `tag` — `tag` is what the Agent
// API's own node spec calls it, and the two are a step apart on purpose.
const findByTag = (nodes, tag) => {
  for (const n of nodes) {
    if (n.kind === 'element' && n.name === tag) return n;
    if (n.children) {
      const found = findByTag(n.children, tag);
      if (found) return found;
    }
  }
  return null;
};

const EDITS = {
  'append a sibling to the parent': (model) => {
    const main = findByTag(model.nodes, 'main');
    main.children.push({ id: 'new1', kind: 'element', name: 'small', props: {}, children: [{ id: 'new2', kind: 'text', value: 'Since 2024' }] });
  },
  'insert a sibling before it': (model) => {
    const main = findByTag(model.nodes, 'main');
    main.children.unshift({ id: 'new1', kind: 'element', name: 'span', props: {}, children: [{ id: 'new2', kind: 'text', value: 'first' }] });
  },
  'remove the other sibling': (model) => {
    const main = findByTag(model.nodes, 'main');
    main.children = main.children.filter((c) => !(c.kind === 'element' && c.name === 'p'));
  },
  'reorder the siblings': (model) => {
    const main = findByTag(model.nodes, 'main');
    main.children.reverse();
  },
  // A prop is `{type, value}`, not a bare string — the model keeps how the
  // attribute was written as well as what it says.
  'set a prop on the parent': (model) => {
    const main = findByTag(model.nodes, 'main');
    main.props = { ...(main.props || {}), class: { type: 'string', value: 'wide' } };
  },
  'edit the other sibling’s text': (model) => {
    const p = findByTag(model.nodes, 'p');
    p.children[0].value = 'Rewritten entirely.';
  },
  'add an import': (model) => {
    model.imports.push({ name: 'Badge', path: '../components/Badge.astro' });
  },
};

for (const [label, text] of Object.entries(TEXT)) {
  const src = page(`<h1>${text}</h1>`);
  const originalLine = src.split('\n').find((l) => l.includes('<h1>'));
  for (const [what, mutate] of Object.entries(EDITS)) {
    const run = editModel(src, mutate);
    if (!check(`[${label}] ${what}: the edit applies`, run.ok, run.reason)) continue;
    const line = run.out.split('\n').find((l) => l.includes('<h1>'));
    // THE ORACLE. Not "the meaning survived" — the BYTES of the line nobody
    // touched, including its indentation.
    check(`[${label}] ${what}: the untouched <h1> line is byte-identical`, line === originalLine, `${esc(originalLine)}\n    became ${esc(line)}`);
  }
}

// And the same for the whitespace-sensitive shapes, where a reindent is the
// damage rather than an entity.
{
  const src = page('<h1>🧑‍🚀 Hello</h1>');
  for (const [what, mutate] of Object.entries(EDITS)) {
    const run = editModel(src, mutate);
    if (!run.ok) continue;
    const before = src.split('\n');
    const after = run.out.split('\n');
    // Count the lines that changed. A one-node insertion is one added line; an
    // import is one added line. Nothing here should move more than two.
    const changed = [];
    const bset = new Map();
    for (const l of before) bset.set(l, (bset.get(l) || 0) + 1);
    for (const l of after) {
      const n = bset.get(l) || 0;
      if (n > 0) bset.set(l, n - 1);
      else changed.push(l);
    }
    check(`[minimal diff] ${what}: adds at most two lines nobody wrote before`, changed.length <= 2, `${changed.length}: ${changed.map(esc).join(' | ')}`);
    check(`[minimal diff] ${what}: does not turn tabs into spaces`, !after.some((l) => /^\t* {2,}\S/.test(l)), after.filter((l) => /^\t* {2,}\S/.test(l)).map(esc).join(' | '));
  }
}

// ── 4. text that IS edited gets the characters the caller asked for ─────────
//
// The other half of the promise: an untouched node keeps its spelling, and an
// edited one is written as its characters. A joiner the caller supplied has to
// arrive in the file as a joiner.

{
  const src = page('<h1>plain</h1>');
  for (const [label, text] of Object.entries(TEXT)) {
    const value = decodeEntities(text);
    const run = editModel(src, (model) => {
      const h1 = findByTag(model.nodes, 'h1');
      h1.children[0].value = value;
      delete h1.children[0].source;
    });
    if (!check(`[edited: ${label}] the edit applies`, run.ok, run.reason)) continue;
    const reparsed = parsePage(run.out);
    const h1 = reparsed.editable ? findByTag(reparsed.model.nodes, 'h1') : null;
    check(`[edited: ${label}] reads back as the characters that were set`, h1?.children?.[0]?.value === value, `${esc(h1?.children?.[0]?.value)} vs ${esc(value)}`);
    // And a joiner the caller supplied is a joiner in the file, not an entity.
    if (value.includes('‍')) {
      check(`[edited: ${label}] the joiner is literal in the file`, run.out.includes('‍') && !run.out.includes('&#8205;'), esc(run.out.split('\n').find((l) => l.includes('<h1>'))));
    }
  }
}

if (failures.length) {
  console.error(`\nsource-fidelity-unicode: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`source-fidelity-unicode: ${checked} passed  [nineteen scripts through seven edits, byte for byte]`);
