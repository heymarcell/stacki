// WHICH ELEMENTS THIS PROJECT'S CSS COULD TURN INTO WHITESPACE-SIGNIFICANT ONES.
//
// `electron/astroParser.js` refuses to reindent a block whose leading spaces
// the browser renders, because a reindent slices the same prefix off every line
// in the block and inside such an element those spaces are content. It can see
// the tags that are always content (`pre`, `textarea`, `script`, `style`) and a
// `white-space` declaration written ON the element. It cannot see the one that
// does the same thing from a stylesheet:
//
//     .preserved { white-space: pre; }
//
// Measured through the real product API, an authored `alpha\n      beta\ngamma`
// inside `<div class='preserved'>` came back `alpha\n    beta\ngamma` on a move
// up one nesting level, `ok: true`, nothing downstream noticing. In a real
// Blink window that is not cosmetic: the 'beta' line went from 96.33px to
// 77.06px, exactly the two monospace glyphs that were deleted.
//
// THIS IS NOT A CASCADE, AND MUST NOT BECOME ONE. The parser asks one
// one-sided question -- "could ANY rule in this project make this element's
// whitespace into rendered content?" -- and only ever acts on the answer NO. So
// an over-approximation is sound: every rule that MIGHT match contributes its
// tokens, a selector shape the reducer does not fully understand contributes
// the sentinel ANY, and every failure (a file that will not read, a stylesheet
// postcss will not parse) also contributes ANY. Being wrong in that direction
// costs an element its reindentation, which is cosmetic. Being wrong the other
// way deletes bytes the page shows.
//
// AND IT IS NOT `getComputedStyle`. The live preview could answer this exactly,
// and using it would make the bytes written to disk depend on whether a window
// happens to be open, which route it happens to show, and when the paint
// landed -- and it still could not answer about a DESTINATION context that does
// not exist until after the write. The preview's only legitimate role here is
// as a test oracle.

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const { findStylesheets } = require('./cssVars');

// The sentinel for "some rule in this project may match anything". A real token
// is always prefixed (`.name`, `#name`) or a bare tag name, so `*` cannot
// collide with one.
const ANY = '*';

// A file bigger than this is a build artefact, not something an author wrote a
// `white-space` rule in by hand. It still has to be accounted for rather than
// skipped, so it contributes ANY like every other thing not read.
const MAX_BYTES = 2 * 1024 * 1024;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki']);

// THE THREE VALUES THAT RENDER DIFFERENTLY AFTER A REINDENT, AND THE THREE THAT
// DO NOT. Measured in a real Blink window: with `pre`, `pre-wrap` and
// `break-spaces` the reindented line moves; with `pre-line`, `normal` and
// `nowrap` it does not, because those three collapse runs of spaces and only
// `pre-line` keeps the newlines. `pre-line` is therefore deliberately absent:
// refusing on it is safe but it refuses a reindent that is provably neutral,
// and the point of this whole mechanism is to be a narrowing rather than a
// switch-off.
const PRESERVING_VALUE = /^(pre|pre-wrap|break-spaces)$/i;

/**
 * The tokens the SUBJECT of one selector can match, or `[ANY]`.
 *
 * The subject is the rightmost compound -- `.card p` styles the `p`, not the
 * `.card` -- and only tokens that identify an element are useful: a class, an
 * id, a tag name. Anything else in that compound (`*`, an attribute selector, a
 * pseudo, `:is()`/`:where()`/`:has()`, a nesting `&`) is a shape this reducer
 * does not claim to understand, and an unknown shape is ANY rather than a
 * guess.
 */
function tokensOfSelector(selector) {
  const s = String(selector || '').trim();
  if (!s) return [ANY];
  // Parentheses and brackets can hold combinators and spaces of their own, so
  // this split can cut one of them in half. It does not need a rule of its own:
  // a fragment torn out of a `(...)` or a `[...]` keeps the bracket that closed
  // it, and the tokenizer below refuses every character it does not understand,
  // so every such selector arrives at ANY through the one gate rather than
  // through two. What survives the split cleanly -- the `.b` of `.a[x] .b` --
  // really is the subject.
  const parts = s.split(/[\s>+~]+/).filter(Boolean);
  const subject = parts[parts.length - 1];
  if (!subject) return [ANY];
  const out = [];
  let i = 0;
  while (i < subject.length) {
    const rest = subject.slice(i);
    const hit = /^(?:([.#])(-?[A-Za-z_][\w-]*)|([A-Za-z][\w-]*))/.exec(rest);
    if (!hit) return [ANY];
    if (hit[1]) out.push(hit[1] + hit[2]);
    else out.push(hit[3].toLowerCase());
    i += hit[0].length;
  }
  return out.length ? out : [ANY];
}

/**
 * Does this declaration make the element's whitespace into rendered content?
 *
 * `!important` is noise here -- the question is what the value SAYS, not who
 * wins. A value this cannot read statically (`var(--ws)`, a value built by
 * something else) is treated as preserving, because the answer this function is
 * allowed to be wrong about is only the one that refuses a reindent.
 */
function declarationPreserves(decl) {
  if (!decl || decl.prop == null) return false;
  if (String(decl.prop).trim().toLowerCase() !== 'white-space') return false;
  const value = String(decl.value || '')
    .replace(/!\s*important\s*$/i, '')
    .trim();
  if (/var\s*\(/i.test(value)) return true;
  return PRESERVING_VALUE.test(value);
}

/**
 * Every token any preserving rule in one stylesheet's text can match.
 *
 * Exported because it is the whole reducer and it is a pure function of a
 * string, so it can be driven directly rather than through a project on disk.
 * A text postcss will not parse answers `[ANY]`: an unparseable stylesheet is
 * a stylesheet whose rules are unknown, and unknown is the refusing answer.
 */
function tokensInCss(text) {
  const found = new Set();
  let root;
  try {
    root = postcss.parse(String(text));
  } catch {
    return new Set([ANY]);
  }
  root.walkRules((rule) => {
    let preserves = false;
    rule.each((node) => {
      if (node.type === 'decl' && declarationPreserves(node)) preserves = true;
    });
    if (!preserves) return;
    // A rule nested inside `@media`, `@supports`, `@layer` or a parent rule
    // still applies to something; the at-rule only says when. Its selector is
    // reduced exactly as a top-level one is, and a nested `&` reduces to ANY
    // through the reducer's own unknown-shape rule.
    for (const one of rule.selectors || [rule.selector]) {
      for (const token of tokensOfSelector(one)) found.add(token);
    }
  });
  return found;
}

/** Every `<style>` block's text out of one Astro/Svelte/Vue-shaped file. */
function styleBlocksIn(text) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let hit;
  while ((hit = re.exec(text)) !== null) out.push(hit[1]);
  return out;
}

/**
 * Every file whose text could hold a rule: the project's stylesheets, and the
 * `<style>` blocks of its pages, layouts and components.
 *
 * Whose components a page actually uses is a question about imports, and
 * answering it wrongly is the one direction that loses bytes -- so the scan is
 * the whole of `src`, which is a superset of any page's own chain and is sound
 * for a question only ever read as NO.
 */
function sourcesOf(projectPath) {
  const files = [...findStylesheets(projectPath)];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(astro|svelte|vue|html)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(projectPath, 'src'), 0);
  return [...new Set(files)].sort();
}

// The last answer, and the stamp it was computed from. A page:write asks this
// on every save and the answer changes only when a file does, so the scan is
// keyed on the same thing a rebuild would be: every candidate file's path, size
// and mtime.
let cached = null;

function stampOf(files) {
  const parts = [];
  for (const abs of files) {
    try {
      const st = fs.statSync(abs);
      parts.push(`${abs}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${abs}:gone`);
    }
  }
  return parts.join('|');
}

/**
 * The token set for one project, or a set holding only ANY when the project
 * cannot be scanned at all.
 *
 * Never throws and never returns null: a caller that gets a set has an answer
 * it can act on, and the answer to "something went wrong" is the one that
 * refuses reindentation rather than the one that permits it.
 */
function preservingTokens(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') return new Set();
  let files;
  try {
    files = sourcesOf(projectPath);
  } catch {
    return new Set([ANY]);
  }
  const stamp = `${projectPath}\n${stampOf(files)}`;
  if (cached && cached.stamp === stamp) return cached.tokens;

  const tokens = new Set();
  for (const abs of files) {
    let text;
    try {
      if (fs.statSync(abs).size > MAX_BYTES) {
        tokens.add(ANY);
        continue;
      }
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      // A FILE THAT WILL NOT READ IS NOT A FILE WITH NO RULES IN IT.
      // Answering "no tokens" here is how a permissions error or a file
      // deleted mid-scan would quietly re-enable a reindent that deletes
      // rendered spaces.
      tokens.add(ANY);
      continue;
    }
    const texts = /\.css$/i.test(abs) ? [text] : styleBlocksIn(text);
    for (const one of texts) for (const token of tokensInCss(one)) tokens.add(token);
  }
  cached = { stamp, tokens };
  return tokens;
}

/** For a test that needs the next call to do the work again. */
function forgetCache() {
  cached = null;
}

module.exports = {
  preservingTokens,
  tokensInCss,
  styleBlocksIn,
  forgetCache,
};
