// What a read says about what it actually returned.
//
//   node test/source-ranges.js
//
// A read is a claim, and an agent has nothing but the claim. If `source.read`
// answers `{ok:true, startLine:9000, endLine:250, text:"", bytes:5610}` the
// agent believes it read lines 9000 to 250 of something, that the region was
// empty, and that 5610 bytes came back. Three lies in one envelope, and the
// only one visible from the outside is the inverted range.
//
// So every check here compares a field against the thing it names -- the bytes
// on disk, the bytes in `text`, the real line the declaration is on -- and
// never against another field of the same answer.
//
// Five things, all of the same shape:
//
//   source.read        an impossible range is refused the way replace_range
//                      already refuses one, and `bytes` describes the payload.
//   source.replace_range  a line range replacement is made of whole lines, in
//                      the file's own line endings, and an empty text deletes.
//   source.read_symbol Stacki has no JavaScript parser and cannot cut a symbol
//                      out of a module. The payload says which file it is,
//                      rather than calling a whole file a symbol.
//   style.variables    `limit` is about the variables, and the answer says how
//                      many there were.
//   target.read        the source snippet is the bulk of a tree walk, and an
//                      agent walking a tree can ask for it not to be sent.

const fs = require('node:fs');
const path = require('node:path');
const H = require('./agent-harness.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  return !!condition;
};
const short = (x, n = 300) => JSON.stringify(x ?? null).slice(0, n);

// Ten lines, LF, terminated. The shape every off-by-one lives in.
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const TEN_CRLF = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';

// A module with three functions in it, so a whole-file answer to a
// one-symbol question is unmistakably a whole file.
const MANY = `// helpers nobody asked to read all of
export function first(a) {
  return a + 1;
}

export function second(a, b) {
  const sum = a + b;
  return sum * 2;
}

export function third() {
  return 'third';
}
`;

(async () => {
  const root = H.makeProject({
    // 71 tokens in their own stylesheet, plus the fixture's own --gap and
    // --brand: 73 variables across 2 files, so `limit` acting on files and
    // `limit` acting on variables cannot give the same answer.
    'src/styles/tokens.css': `:root {\n${Array.from({ length: 71 }, (_, i) => `  --t-${i + 1}: ${i + 1}px;`).join('\n')}\n}\n`,
    'src/layouts/Base.astro': "---\nimport '../styles/site.css';\nimport '../styles/tokens.css';\n---\n<html lang=\"en\">\n  <head><title>Fixture</title></head>\n  <body>\n    <slot />\n  </body>\n</html>\n",
    'src/lib/ten.txt': TEN,
    'src/lib/crlf.txt': TEN_CRLF,
    'src/lib/empty.txt': '',
    'src/lib/one.txt': 'only line, no terminator',
    'src/lib/many.js': MANY,
  });
  const app = await H.start(root);
  const run = (domain, action, args) => app.api.run(domain, action, args);
  const onDisk = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  // Every replace_range case starts from a file nobody else has touched, and
  // is guarded with the digest of the version it is replacing -- an unguarded
  // write is correctly refused, and a test that fought that would be testing
  // the harness rather than the splice.
  const fresh = async (rel, body) => {
    fs.writeFileSync(path.join(root, rel), body, 'utf8');
    const read = await run('source', 'read', { path: rel });
    return read.digest;
  };

  try {
    // ── source.read: an impossible range is not a successful empty read ──────
    {
      const beyond = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 9000 });
      check('a read that starts past the end of the file is refused', beyond.ok === false, short(beyond));
      check('  with a code an agent can branch on', beyond.code === 'bad_range', short(beyond.code));
      check('  naming how long the file really is', /\b10 lines\b/.test(String(beyond.message)), short(beyond.message));
      check('  and no inverted range echoed back as fact', beyond.startLine === undefined && beyond.endLine === undefined, short(beyond));

      const inverted = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 8, endLine: 3 });
      check('an inverted range inside the file is refused', inverted.ok === false && inverted.code === 'bad_range', short(inverted));
      check('  and says which end is wrong', /endLine/.test(String(inverted.message)), short(inverted.message));

      const whole = await run('source', 'read', { path: 'src/lib/ten.txt' });
      check('a whole-file read reports the range it returned', whole.startLine === 1 && whole.endLine === 10, short(whole));
      check('  and how many lines the file has, not how many \\n segments', whole.lines === 10, short({ lines: whole.lines }));
      check('  and text is the file', whole.text === TEN, short(whole.text));
      check(
        '  and bytes is the bytes that came back',
        whole.bytes === Buffer.byteLength(TEN, 'utf8') && whole.wholeFileBytes === Buffer.byteLength(TEN, 'utf8'),
        short({ bytes: whole.bytes, wholeFileBytes: whole.wholeFileBytes, onDisk: Buffer.byteLength(TEN, 'utf8') })
      );

      const clipped = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 3, endLine: 5 });
      // Whole lines, terminators attached — the bytes that sit at those lines,
      // so the same text handed back to replace_range is a no-op.
      check('a clipped read returns exactly that range', clipped.text === 'line 3\nline 4\nline 5\n', short(clipped.text));
      check(
        '  and bytes describes the 21 bytes returned, not the 71 on disk',
        clipped.bytes === Buffer.byteLength(clipped.text, 'utf8'),
        short({ bytes: clipped.bytes, textBytes: Buffer.byteLength(String(clipped.text), 'utf8') })
      );
      // The discriminator: renaming the old whole-file number would satisfy the
      // line above and still be the same lie.
      check(
        '  and the two numbers disagree, because the payload is not the file',
        clipped.bytes !== clipped.wholeFileBytes && clipped.wholeFileBytes === Buffer.byteLength(TEN, 'utf8'),
        short({ bytes: clipped.bytes, wholeFileBytes: clipped.wholeFileBytes })
      );

      const past = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 9, endLine: 400 });
      check('an endLine past the end is a read, not a refusal', past.ok === true, short(past));
      check('  clamped to the file', past.endLine === 10 && past.text === 'line 9\nline 10\n', short(past));
      check('  and it says the clamp happened', past.clampedEnd === true, short({ clampedEnd: past.clampedEnd }));

      const atEof = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 10, endLine: 10 });
      check('exactly the last line is readable', atEof.ok === true && atEof.text === 'line 10\n', short(atEof.text));
      check('  and is not reported as a clamp', atEof.clampedEnd !== true, short({ clampedEnd: atEof.clampedEnd }));

      const empty = await run('source', 'read', { path: 'src/lib/empty.txt' });
      check('an empty file has no lines and no bytes', empty.ok === true && empty.lines === 0 && empty.bytes === 0, short(empty));
      const emptyRange = await run('source', 'read', { path: 'src/lib/empty.txt', startLine: 1 });
      check('  and line 1 of it is refused rather than invented', emptyRange.ok === false && emptyRange.code === 'bad_range', short(emptyRange));

      const one = await run('source', 'read', { path: 'src/lib/one.txt' });
      check('a one-line file with no terminator is one line', one.lines === 1 && one.startLine === 1 && one.endLine === 1, short(one));

      const crlf = await run('source', 'read', { path: 'src/lib/crlf.txt', startLine: 3, endLine: 5 });
      check('a CRLF file reads back its own line endings', crlf.text === 'line 3\r\nline 4\r\nline 5\r\n', short(crlf.text));
      check('  and counts CRLF lines as lines', crlf.lines === 10, short({ lines: crlf.lines }));
    }

    // ── source.replace_range: whole lines, the file's endings, and deletion ──
    {
      const cases = [
        ['a trailing newline terminates the replacement, it is not an extra blank line', 'src/lib/ten.txt', TEN, { startLine: 3, endLine: 3, text: 'REPLACED\n' }, TEN.replace('line 3\n', 'REPLACED\n')],
        ['the same replacement without the newline means the same thing', 'src/lib/ten.txt', TEN, { startLine: 3, endLine: 3, text: 'REPLACED' }, TEN.replace('line 3\n', 'REPLACED\n')],
        ['a second newline IS a blank line the caller asked for', 'src/lib/ten.txt', TEN, { startLine: 3, endLine: 3, text: 'REPLACED\n\n' }, TEN.replace('line 3\n', 'REPLACED\n\n')],
        ['an empty replacement deletes the range', 'src/lib/ten.txt', TEN, { startLine: 3, endLine: 3, text: '' }, TEN.replace('line 3\n', '')],
        ['a multi-line replacement of a multi-line range', 'src/lib/ten.txt', TEN, { startLine: 3, endLine: 4, text: 'X\nY\n' }, TEN.replace('line 3\nline 4\n', 'X\nY\n')],
        ['replacing the last line leaves no blank line after it', 'src/lib/ten.txt', TEN, { startLine: 10, endLine: 10, text: 'LAST\n' }, TEN.replace('line 10\n', 'LAST\n')],
        ['appending past the last line is still how you append', 'src/lib/ten.txt', TEN, { startLine: 11, endLine: 11, text: 'AFTEREOF\n' }, TEN + 'AFTEREOF\n'],
        ['a CRLF file keeps CRLF', 'src/lib/crlf.txt', TEN_CRLF, { startLine: 3, endLine: 3, text: 'REPLACED\n' }, TEN_CRLF.replace('line 3\r\n', 'REPLACED\r\n')],
        ['a CRLF file gets CRLF blank lines too', 'src/lib/crlf.txt', TEN_CRLF, { startLine: 3, endLine: 3, text: 'A\n\n' }, TEN_CRLF.replace('line 3\r\n', 'A\r\n\r\n')],
        ['a file with no terminator does not acquire one', 'src/lib/one.txt', 'only line, no terminator', { startLine: 1, endLine: 1, text: 'END' }, 'END'],
      ];
      for (const [what, rel, body, args, want] of cases) {
        const digest = await fresh(rel, body);
        const answer = await run('source', 'replace_range', { path: rel, ...args, expectedDigest: digest });
        const got = onDisk(rel);
        check(what, answer.ok === true && got === want, short({ ok: answer.ok, code: answer.code, got, want }, 500));
      }

      // The strongest form: a range read and written back unchanged is a no-op.
      const digest = await fresh('src/lib/ten.txt', TEN);
      const slice = await run('source', 'read', { path: 'src/lib/ten.txt', startLine: 4, endLine: 6 });
      const back = await run('source', 'replace_range', { path: 'src/lib/ten.txt', startLine: 4, endLine: 6, text: slice.text, expectedDigest: digest });
      check('a range replaced with its own text leaves the file byte-identical', back.ok === true && onDisk('src/lib/ten.txt') === TEN, short({ code: back.code, got: onDisk('src/lib/ten.txt') }, 400));

      const crlfDigest = await fresh('src/lib/crlf.txt', TEN_CRLF);
      const crlfSlice = await run('source', 'read', { path: 'src/lib/crlf.txt', startLine: 4, endLine: 6 });
      const crlfBack = await run('source', 'replace_range', { path: 'src/lib/crlf.txt', startLine: 4, endLine: 6, text: crlfSlice.text, expectedDigest: crlfDigest });
      check('and so does the same round trip through a CRLF file', crlfBack.ok === true && onDisk('src/lib/crlf.txt') === TEN_CRLF, short({ code: crlfBack.code, got: onDisk('src/lib/crlf.txt') }, 400));
      check('  with no bare LF anywhere in it', !/[^\r]\n/.test(onDisk('src/lib/crlf.txt')), short(onDisk('src/lib/crlf.txt'), 200));

      const outOfRange = await fresh('src/lib/ten.txt', TEN);
      const refused = await run('source', 'replace_range', { path: 'src/lib/ten.txt', startLine: 40, endLine: 40, text: 'x', expectedDigest: outOfRange });
      check('a range that is not in the file is still refused', refused.ok === false && refused.code === 'bad_request', short(refused));
      check('  and nothing was written', onDisk('src/lib/ten.txt') === TEN);
    }

    // ── source.read_symbol: honest about being a whole file ─────────────────
    {
      const sym = await run('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../lib/many.js', name: 'second' });
      check('read_symbol answers', sym.ok === true, short(sym));
      check('  with the whole file, and says so', sym.wholeFile === true, short({ wholeFile: sym.wholeFile }));
      check('  which is byte-identical to the file on disk', sym.text === MANY, short(sym.text));
      const wantLine = MANY.split('\n').findIndex((l) => /export function second/.test(l)) + 1;
      check('  and points at the declaration by its real line', sym.declarationLine === wantLine, short({ declarationLine: sym.declarationLine, wantLine }));
      check(
        '  and claims no symbol range it cannot compute',
        sym.startLine === undefined && sym.endLine === undefined,
        short({ startLine: sym.startLine, endLine: sym.endLine })
      );

      // The composition the honest contract promises: take the declaration
      // line, read the span yourself. Line 0 could not have done this.
      const cut = await run('source', 'read', { path: sym.file, startLine: sym.declarationLine, endLine: sym.declarationLine + 3 });
      check('  and that line is usable as a source.read range', cut.ok === true && /^export function second\(a, b\) \{\n/.test(String(cut.text)), short(cut.text));

      const noMatch = await run('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../components/Card.astro', name: 'Card' });
      check('a symbol with no declaration to point at says so', noMatch.ok === true && noMatch.declarationLine === null, short({ declarationLine: noMatch.declarationLine }));
      check('  rather than reporting line 0 as if it were a line', noMatch.declarationLine !== 0, short({ declarationLine: noMatch.declarationLine }));

      const missing = await run('source', 'read_symbol', { fromFile: 'src/pages/index.astro', spec: '../lib/nope.js', name: 'x' });
      check('an unresolvable specifier is still a refusal', missing.ok === false && missing.code === 'not_found', short(missing));
    }

    // ── style.variables: `limit` is about the variables ──────────────────────
    //
    // The dogfood asked for 5 and got 71, in ~14 KB. The field was not being
    // ignored: it was capping the FILE array while `values` -- a flat map of
    // every name in the project, and the bulk of the bytes -- went past it
    // whole. Asking for five of something and being handed all of it is worse
    // than the argument not existing, because a client cannot see that it
    // happened.
    {
      const cellsIn = (v) =>
        (v.files || []).flatMap((f) => (f.groups || []).flatMap((g) => (g.blocks || []).flatMap((b) => (b.rows || []).flatMap((r) => r.cells || []))));

      const all = await run('style', 'variables', {});
      const TOTAL = 73;
      check('the fixture really has 73 variables in 2 files', cellsIn(all).length === TOTAL && all.files.length === 2, short({ cells: cellsIn(all).length, files: all.files?.length }));
      check('  and with no limit they all come back', all.returned === TOTAL && all.total === TOTAL && all.truncated === false, short({ returned: all.returned, total: all.total, truncated: all.truncated }));
      check('  with the values map the Variables panel reads', all.values['--gap'] === '1rem' && Object.keys(all.values).length === TOTAL, short({ gap: all.values?.['--gap'], values: Object.keys(all.values || {}).length }));
      const wholeBytes = JSON.stringify(all).length;

      const one = await run('style', 'variables', { limit: 1 });
      check('limit 1 returns one variable', cellsIn(one).length === 1 && one.returned === 1, short({ cells: cellsIn(one).length, returned: one.returned }));
      check('  and says how many there were', one.total === TOTAL && one.truncated === true, short({ total: one.total, truncated: one.truncated }));
      check('  and does not smuggle the other 72 through values', Object.keys(one.values).length === 1 && one.valuesTotal === TOTAL, short({ values: Object.keys(one.values || {}).length, valuesTotal: one.valuesTotal }));

      const five = await run('style', 'variables', { limit: 5 });
      const fiveBytes = JSON.stringify(five).length;
      check('limit 5 returns five variables', cellsIn(five).length === 5 && five.returned === 5, short({ cells: cellsIn(five).length, returned: five.returned }));
      check('  and five values', Object.keys(five.values).length === 5, short({ values: Object.keys(five.values || {}).length }));
      // The byte size is the thing the caller was actually asking about, and a
      // count that shrinks while the payload does not is the bug wearing a hat.
      check(`  and the answer is small: ${fiveBytes} bytes against ${wholeBytes} for the lot`, fiveBytes < 4000 && fiveBytes < wholeBytes / 4, short({ fiveBytes, wholeBytes }));

      const exact = await run('style', 'variables', { limit: TOTAL });
      check('a limit of exactly the total is not a truncation', cellsIn(exact).length === TOTAL && exact.returned === TOTAL && exact.truncated === false, short({ cells: cellsIn(exact).length, truncated: exact.truncated }));
      check('  and the values map is whole again', Object.keys(exact.values).length === TOTAL, short({ values: Object.keys(exact.values || {}).length }));

      const over = await run('style', 'variables', { limit: TOTAL + 100 });
      check('a limit above the total returns the total, not a padded list', cellsIn(over).length === TOTAL && over.returned === TOTAL && over.truncated === false, short({ cells: cellsIn(over).length, truncated: over.truncated }));

      // The Variables panel and agent-canvas both edit by offset, so a trimmed
      // cell that lost its offsets would be a cell nothing can write through.
      const kept = cellsIn(five)[0];
      check('  and a returned variable still carries what an edit needs', typeof kept?.name === 'string' && typeof kept?.valueStart === 'number' && typeof kept?.file === 'string', short(kept));
    }
  } finally {
    await app.stop?.();
    H.removeProject(root);
  }
  check('the fixture is gone', !fs.existsSync(root), root);

  if (failures.length) {
    console.error(`source-ranges: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`source-ranges: ${checked} passed  [a read describes what it returned]`);
})().catch((err) => {
  console.error('source-ranges: threw\n', err?.stack || err);
  process.exit(1);
});
