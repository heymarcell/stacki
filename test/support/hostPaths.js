// Every way a payload could name a place on THIS machine — one definition.
//
// TWO COPIES OF ONE RULE DRIFTED, AND THE WEAK ONE WAS THE ORACLE.
//
// This started as a function in test/refusal-contract.js and was copied into
// test/undo-transaction.js under a docstring saying it was "the same function,
// at the same strength". It was not. The copy's character classes omitted the
// apostrophe and the backtick on both ends of the shape rule, which is exactly
// the form every Node fs error uses:
//
//   EACCES: permission denied, open '/Users/someone/other/x.css'
//
// The character before `/Users` there is `'`, so the anchor never matched and
// the oracle saw nothing. Every assertion built on it is an ABSENCE — "this
// refusal names no host path" — so a blind oracle satisfies all of them and the
// suite stays green while a refusal ships the user's home directory to an agent.
// The gap had already been found and closed once, in the other copy; the copy
// that was not touched kept it.
//
// So the rule lives here, in one place, and the strength is not a property of
// whichever file you happen to be reading.
//
// WHAT IS STILL A COPY, said out loud rather than left to be discovered:
// test/refusal-contract.js carries its own (currently equivalent) version. That
// file is not this change's to edit, so this module is the canonical one and
// that copy is the one still to move. Anything new asks here.

const fs = require('node:fs');
const os = require('node:os');

/**
 * Absolute, machine-specific paths named anywhere in `payload`.
 *
 * Returns a list of human-readable hits, empty when the payload names none —
 * so `hostPathsIn(x, root).length === 0` is the assertion, and the list itself
 * is the failure message.
 *
 * `payload` may be a string (an error message on its own) or any JSON value (a
 * whole wire envelope); an object is compared in its serialized form, which is
 * the form that actually crosses the wire.
 *
 * FOUR NAMED SPELLINGS, THEN A SHAPE. The named four are the ones that can
 * really appear: the fixture root, its realpath (macOS mounts /var as a link to
 * /private/var, so a handler that resolved a path answers the OTHER spelling
 * and a substring check for the root alone misses it), the temp directory and
 * the home directory. The shape rule behind them catches a fifth nobody thought
 * of — a path from somewhere none of the four covers.
 *
 * THE SHAPE RULE IS ANCHORED ON PURPOSE. It cannot simply look for a leading
 * slash: these refusals are allowed and expected to name project-relative files
 * like `src/pages/index.astro`, and a rule that fired on any `/` would call
 * every one of those a leak. So it anchors on the characters a path is
 * introduced by — start of text, a space, an opening paren, or any of the three
 * quotes a message can wrap a path in. The three quotes close the run too: a
 * hit must not swallow the quote that ended it.
 */
function hostPathsIn(payload, root) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  const hits = [];
  const named = [
    ['the fixture root', root],
    ['the fixture root, resolved', root ? fs.realpathSync(root) : null],
    ['the temp directory', os.tmpdir()],
    ['the home directory', os.homedir()],
  ];
  for (const [what, needle] of named) {
    if (needle && needle !== '/' && text.includes(needle)) hits.push(`${what} (${needle})`);
  }
  for (const m of text.matchAll(
    /(?:^|["'`\s(])(\/(?:Users|home|var|private|tmp|opt|etc|Applications|Library)\/[^"'`\s)]{2,})/g
  )) {
    hits.push(`an absolute path: ${m[1].slice(0, 80)}`);
  }
  return hits;
}

/**
 * The messages that must be SEEN, for a suite to prove its oracle still looks.
 *
 * Every assertion built on `hostPathsIn` is an absence, so a positive control
 * is not optional: without one, an oracle that had stopped matching altogether
 * passes the entire suite. Each entry is `[what, message(needle)]`, and the
 * needle a caller passes is a real absolute path.
 *
 * The apostrophe row is the regression itself — it is the spelling Node's fs
 * errors use, and it is what the drifted copy could not see.
 */
const QUOTINGS = [
  ['bare, after a space', (p) => `open ${p}/x.css`],
  ["inside single quotes, as every Node fs error writes it", (p) => `EACCES: permission denied, open '${p}/x.css'`],
  ['inside double quotes', (p) => `could not read "${p}/x.css"`],
  ['inside backticks', (p) => `could not read \`${p}/x.css\``],
  ['in parentheses', (p) => `read failed (${p}/x.css)`],
];

module.exports = { hostPathsIn, QUOTINGS };
