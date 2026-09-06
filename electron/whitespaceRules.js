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
// the sentinel ANY, and every failure contributes ANY too. The failures, named
// rather than implied, because "every failure also contributes ANY" was written
// here while one of them did the opposite: a file that will not read, a
// DIRECTORY that will not list, a stylesheet postcss will not parse, one too
// big to be worth reading, a walk that hit its depth cap or its entry or time
// budget, a FILE LIST that hit its cap, a READ PHASE that ran out of time, a
// symlink that will not resolve, a symlink that resolves OUTSIDE the project
// and is deliberately not followed, and an entry with a stylesheet's NAME that
// is not a regular file at all. Being wrong in that direction costs an element
// its reindentation, which is cosmetic. Being wrong the other way deletes bytes
// the page shows.
//
// AND ANY IS NOT "EVERY ELEMENT PRESERVES ITS WHITESPACE". THE SENTINEL DAMAGED
// LAYOUT WHILE IT WAS READ THAT WAY. "We cannot prove a reindent here is safe"
// and "this element renders its own whitespace" are different statements, and
// the consumer keeps them apart: the first holds a moved subtree's authored
// bytes, the second additionally says the indentation BETWEEN an element's
// children is content and must not be written at all. Read as the second, one
// stylesheet left mid-edit anywhere in the project put every subsequent page
// write's surrounding markup at COLUMN ZERO -- unrelated `<h2>`s and closing
// tags de-indented, which is an active edit rather than a missing one. See
// `rendersIndent` in electron/astroParser.js, which is built from the named
// tokens alone and never from this sentinel.
//
// AND IT IS NOT `getComputedStyle`. The live preview could answer this exactly,
// and using it would make the bytes written to disk depend on whether a window
// happens to be open, which route it happens to show, and when the paint
// landed -- and it still could not answer about a DESTINATION context that does
// not exist until after the write. The preview's only legitimate role here is
// as a test oracle.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

// The sentinel for "some rule in this project may match anything". A real token
// is always prefixed (`.name`, `#name`) or a bare tag name, so `*` cannot
// collide with one.
const ANY = '*';

// A file bigger than this is a build artefact, not something an author wrote a
// `white-space` rule in by hand. It still has to be accounted for rather than
// skipped, so it contributes ANY like every other thing not read.
const MAX_BYTES = 2 * 1024 * 1024;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki']);

// Deep enough for any hand-written source tree, and a cap rather than a
// promise: a directory below it is a part of the project nobody looked at, and
// hitting it is a failure that contributes ANY rather than a quiet stop.
const MAX_DEPTH = 12;

// AND THE TWO BOUNDS THE DEPTH CAP IS NOT.
//
// `MAX_DEPTH` bounds how DEEP the walk goes and nothing else -- twelve levels
// of a home directory is still every photo, every checkout and every download
// somebody has. This scan runs SYNCHRONOUSLY on the Electron MAIN process
// inside `page:write`, so a walk with no bound on its WIDTH is the same failure
// class as the FIFO named below: no repaint, no IPC, the write neither
// completing nor refusing. Twenty thousand entries is far more than a
// hand-written source tree holds once `SKIP_DIRS` has taken `node_modules`,
// `dist` and the build output out of it, and the wall-clock budget is the same
// bound for a tree that is slow rather than numerous -- a network mount, a
// spun-down disk, a directory whose listing itself takes a second. Hitting
// either is a part of the project nobody looked at, so it contributes ANY like
// every other failure here rather than quietly shortening the file list.
const MAX_ENTRIES = 20000;
const MAX_MS = 2000;

// AND THE TWO BOUNDS THE WALK'S BOUNDS ARE NOT.
//
// `MAX_ENTRIES` and `MAX_MS` bound the DIRECTORY WALK and stop there. The phase
// that does the actual work -- a `statSync`, a `readFileSync` and a
// `postcss.parse` for every file the walk handed back -- had no entry bound and
// no time bound at all, and it runs on the same synchronous main-process
// `page:write` path as the walk does. Twenty thousand entries can be twenty
// thousand stylesheets: the walk stops, hands back the list, and the app then
// blocks reading and parsing all of it, which is the FIFO and the symlinked home
// directory again by a third road -- no repaint, no IPC, the write neither
// completing nor refusing.
//
// So the file list is capped where it is built, which bounds the stamp's stats
// as well as the reads, and the read-and-parse loop carries a wall-clock budget
// of its own for a tree that is slow rather than numerous. Two thousand
// hand-written stylesheets, pages, layouts and components is far more than a
// project has once `SKIP_DIRS` has taken `node_modules` and the build output
// out; the budget is the backstop for media where each read is slow rather than
// each file being large, which is the case no count can bound.
//
// HITTING EITHER CONTRIBUTES ANY, and that is the whole point of bounding it
// here rather than by truncating the list. A short list is not a short project:
// it is the positive answer "nothing in here preserves whitespace", which is
// the answer that reindents rendered content away. The bound has to say "I
// could not tell", so the cap sets the walk's own `failed` flag and the budget
// adds the sentinel directly.
const MAX_FILES = 2000;
const MAX_READ_MS = 2000;

// A FILE THAT IS ITSELF A STYLESHEET, in every spelling Astro takes.
//
// This was `.css` alone, and the four preprocessor extensions Astro supports
// natively were skipped — silently, which is the part that mattered: a skip is
// not a failure, so `failed` stayed false, no ANY sentinel was added, and a
// project whose only rule lived in `site.scss` answered with the EMPTY SET.
// Empty is not "I could not tell"; it is the positive statement "nothing in
// this project preserves whitespace", and it is the one answer that deletes
// bytes the page shows. MEASURED: the same `.preserved { white-space: pre }`
// rule and the same move, `site.css` -> "alpha\n      beta" preserved,
// `site.scss` -> "alpha\n    beta", two rendered spaces gone under ok: true.
//
// postcss reads scss/less/pcss well enough to find the declarations; the
// indented syntaxes (.sass, .styl) it will not parse at all, and that is
// already handled — tokensInCss answers [ANY] for a text it cannot parse, so
// those projects get the refusing answer instead of the empty one. Reading
// them is what makes both outcomes possible; skipping them made only the wrong
// one possible.
const STYLESHEET = /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i;

// Every file whose text could hold a rule. Stylesheets, and the `<style>`
// blocks of pages, layouts and components.
const SOURCE_FILE = /\.(css|pcss|postcss|scss|sass|less|styl|stylus|astro|svelte|vue|html)$/i;

// THE THREE VALUES THAT RENDER DIFFERENTLY AFTER A REINDENT, AND THE THREE THAT
// DO NOT. Measured in a real Blink window: with `pre`, `pre-wrap` and
// `break-spaces` the reindented line moves; with `pre-line`, `normal` and
// `nowrap` it does not, because those three collapse runs of spaces and only
// `pre-line` keeps the newlines. `pre-line` is therefore deliberately absent:
// refusing on it is safe but it refuses a reindent that is provably neutral,
// and the point of this whole mechanism is to be a narrowing rather than a
// switch-off.
const PRESERVING_VALUE = /^(pre|pre-wrap|break-spaces)$/i;

// AND THE LONGHAND THE WHOLE GUARD COULD NOT SEE.
//
// `white-space` is a SHORTHAND in CSS Text 4 and `white-space-collapse` is the
// half of it that decides this question. This reducer asked for the property
// NAME `white-space` and nothing else, so `.preserved { white-space-collapse:
// preserve }` -- the same statement as `.preserved { white-space: pre }`, and
// what that shorthand expands to -- contributed NO token at all. An empty token
// set is not "unknown": it is the positive answer "no rule in this project
// preserves whitespace", so a structural move under that class reindented and
// deleted rendered content, `ok: true`. Measured: `tokensInCss('.preserved {
// white-space-collapse: preserve }')` answered `[]`, and the authored
// `alpha\n      beta\ngamma` came back two spaces shorter.
//
// THE VALUE TABLE IS THE LONGHAND'S OWN, not the property name standing in for
// an answer. Measured in a real Blink window over the same reindent of
// `alpha\n        beta\ngamma`, the same 115.59px/38.53px oracle as above:
// `preserve` and `break-spaces` move the line, `collapse` and `preserve-breaks`
// do not -- `preserve-breaks` being the longhand spelling of `pre-line`, absent
// here for exactly the reason `pre-line` is. `preserve-spaces` is in the spec,
// preserves spaces by definition, and is NOT implemented in this Electron's
// Blink (measured: the declaration does not parse, so nothing was rendered
// differently); it is listed anyway, because over-refusing costs a reindent and
// under-refusing costs bytes.
//
// The neighbours, checked and deliberately absent: `text-wrap` /
// `text-wrap-mode` is the OTHER longhand of the shorthand and cannot reach this
// question (measured: `white-space: pre; text-wrap: wrap` still preserves,
// because wrapping is not collapsing), and `white-space-trim` only DISCARDS
// whitespace, so the most it can do is make a preserved run render less, which
// is the direction that costs a reindent rather than a byte.
const PRESERVING_COLLAPSE_VALUE = /^(preserve|preserve-spaces|break-spaces)$/i;

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
 *
 * TWO PROPERTIES, TWO VALUE TABLES, ONE QUESTION -- see
 * `PRESERVING_COLLAPSE_VALUE` above for why the second one had to exist and
 * what a real Blink window says about each of its values. No cascade is done
 * here and none is wanted: this scan asks "could ANY rule in this project make
 * this element's whitespace into content", so a single preserving declaration
 * anywhere in a rule is enough, whatever else the rule also says.
 */
function declarationPreserves(decl) {
  if (!decl || decl.prop == null) return false;
  const prop = String(decl.prop).trim().toLowerCase();
  if (prop !== 'white-space' && prop !== 'white-space-collapse') return false;
  const value = String(decl.value || '')
    .replace(/!\s*important\s*$/i, '')
    .trim();
  if (/var\s*\(/i.test(value)) return true;
  return prop === 'white-space' ? PRESERVING_VALUE.test(value) : PRESERVING_COLLAPSE_VALUE.test(value);
}

// THE DECLARATION SPELLED AS A UTILITY NAME INSIDE A RULE.
//
// `.preserved { @apply whitespace-pre; }` is the same statement as
// `.preserved { white-space: pre; }`, and postcss hands it over as an AtRule
// rather than a Decl -- so `rule.each` looked straight past it and the rule
// contributed NOTHING, not even ANY. Measured: `tokensInCss('.preserved {
// @apply whitespace-pre; }')` answered `[]`, which the parser reads as the
// positive statement "no rule preserves this element's whitespace", and the
// authored `alpha\n      beta\ngamma` came back two spaces shorter.
//
// The variants are matched loosely on purpose: a configured prefix
// (`tw-whitespace-pre`) or a variant (`md:whitespace-pre`) is still the same
// utility, and over-matching here only ever refuses a reindent.
//
// THE LONGHAND HAS NO UTILITY TO SPELL, which is why it is not in here. Tailwind
// ships `whitespace-*` for the shorthand and nothing for `white-space-collapse`,
// so the only way to `@apply` the longhand is an arbitrary property the utility
// scanner sees as CSS -- and CSS is what `declarationPreserves` above reads.
// Inventing a name here would be matching a spelling nobody writes.
const APPLY_PRESERVES = /whitespace-(pre(-wrap)?|break-spaces)(?![\w-])/i;

// AND THE SPELLINGS WHOSE UTILITY LIST IS NOT IN THE TEXT need no branch here,
// which is worth saying because one was written and then deleted for claiming
// to catch something it never reached. `@apply #{$utils}`, `${utils}` and
// `@{utils}` all make postcss throw on the WORD inside the braces, so the file
// arrives at ANY through `tokensInCss`'s own parse gate before any of this
// runs. What is genuinely left over is an `@apply` naming a custom utility --
// and that is ANY too whenever the utility was declared in CSS the scan
// reached, through the `walkAtRules` pass below. A utility defined in a
// JavaScript config is the residual, and docs/mcp-v1.md says so.

/** Does one at-rule written INSIDE a style rule preserve whitespace? */
function atRuleInRule(at) {
  if (String(at.name || '').toLowerCase() !== 'apply') return false;
  return APPLY_PRESERVES.test(String(at.params || ''));
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
      else if (node.type === 'atrule' && atRuleInRule(node)) preserves = true;
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
  // A DECLARATION THAT NAMES NO ELEMENT, BECAUSE ITS SUBJECT IS A NAME SOMEWHERE
  // ELSE. `@utility keep-space { white-space: pre }` and `@mixin keep-space {
  // white-space: pre }` both declare the property with no selector to reduce,
  // and whatever `@apply keep-space` or `@include keep-space` is written on
  // inherits it. Which elements those are is not answerable from this file
  // alone, so the whole project's answer is ANY -- which is also what covers an
  // `@apply` naming a utility this reducer has never heard of, as long as the
  // utility itself was declared in CSS the scan reached.
  root.walkAtRules((at) => {
    if (typeof at.each !== 'function') return;
    at.each((node) => {
      if (node.type === 'decl' && declarationPreserves(node)) found.add(ANY);
    });
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
 * The only parts of one file this scan actually looks at.
 *
 * A stylesheet file IS the stylesheet; anything else contributes its `<style>`
 * blocks and nothing more. Said once, because the cache stamp below and the
 * reducer below that have to agree about it: while the stamp asked for the
 * `<style>` blocks of every file, a `.css` path handed in as `knownText` was
 * stamped by the blocks of a stylesheet, which are ALWAYS none -- so every
 * possible text of that file produced the same stamp and the cache would have
 * served the first answer for ever.
 */
function readableTexts(abs, text) {
  return STYLESHEET.test(abs) ? [text] : styleBlocksIn(text);
}

// A path that is not there is a fact about the project; anything else is a part
// of it nobody could look at.
const MISSING = (err) => !!err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

/**
 * Every file whose text could hold a rule, and whether the walk saw all of it.
 *
 * ITS OWN WALK, NOT `cssVars.findStylesheets`. That one answers a question
 * where a directory it cannot list is fairly reported as "no variables in
 * there", and it swallows the failure with a bare `return`. Here the same
 * silence is a positive claim -- "this project has no rule that preserves
 * whitespace" -- and it deletes rendered bytes. Measured on one fixture and one
 * move: an unreadable FILE gave `['*']` and kept `alpha\n      beta\ngamma`; an
 * unreadable DIRECTORY holding the same stylesheet gave `[]` and wrote back
 * `alpha\n    beta\ngamma`, two spaces gone. So this walk reports `failed`
 * instead, and it is left as a separate walk rather than pushed down into the
 * shared one, whose callers want the forgiving answer.
 *
 * A directory that is NOT THERE is not a directory that was hidden: a project
 * with no `public/` is a fact, not a failure, and only an error that is neither
 * ENOENT nor ENOTDIR says part of the tree was unreadable.
 *
 * AND A `Dirent` ANSWERS ABOUT THE LINK, NOT ABOUT WHAT IT POINTS AT.
 * `isDirectory()` is FALSE for a symlink to a directory, so `src/styles ->
 * ../../packages/ui/styles` -- the ordinary monorepo shape -- was neither
 * walked nor counted: measured, a real directory answered `['.preserved']` and
 * the identical stylesheet behind a symlinked one answered `[]`, with `failed`
 * still false, and two rendered spaces were then deleted. That is the same `[]`
 * and the same damage the unreadable-directory case above was written for, with
 * no error anywhere. So a symlink is resolved -- with `statSync`, which follows
 * it -- and classified by what it resolves to, and the same rule then covers
 * the FILE symlinks the walk was already reading through, which is the
 * consistency the two halves used not to have. A link that resolves to nothing
 * is ENOENT and is skipped like a directory that is not there; a link that will
 * not resolve for any other reason (a loop, a permission) is a part of the tree
 * nobody looked at, and contributes ANY.
 *
 * Following links means the same directory can be reached twice, and a link
 * pointing at its own ancestor can be reached for ever, so each directory is
 * walked once, keyed on its resolved path.
 *
 * AND FOLLOWING THEM AT ALL IS ONLY DEFENSIBLE INSIDE THE PROJECT. That is the
 * half the monorepo fix above did not write, and without it the fix was worse
 * than the hole it closed: the walk followed ANY directory link, with no
 * containment and no bound, synchronously on the main process. One ordinary
 * `src/docs -> ~/Documents` or `public/assets -> ~/Dropbox` -- a link nothing
 * is wrong with -- then blocked the whole app for tens of seconds on every
 * save, which is the FIFO failure again by another road.
 *
 * So the link is resolved FIRST and classified by where it lands. Inside the
 * project it is ordinary project source and is walked, which is the monorepo
 * shape that mattered. Outside it, it is not followed -- and it contributes ANY
 * rather than being skipped, because a link out of the project is a part of the
 * project this scan deliberately did not look at, and the silent skip is
 * exactly the `[]` that reads as "nothing here preserves whitespace" and
 * deletes rendered bytes. Containment, then the bound, then the honest answer.
 *
 * Containment is asked of the RESOLVED path against the RESOLVED project root,
 * because `/tmp/p/link -> /tmp/p/../p/styles` is inside and a prefix test on
 * the written path cannot tell. The separator is part of the test: `/tmp/proj`
 * must not contain `/tmp/project-two`.
 *
 * AND AN ENTRY WITH A STYLESHEET'S NAME THAT IS NOT A FILE. The walk classified
 * with `isDirectory()` and an `else`, so anything else whose name matched --
 * a FIFO, a socket, a device -- was added to the list. `preservingTokens` runs
 * SYNCHRONOUSLY on the Electron main process inside `page:write`, and
 * `statSync` reports a FIFO's size as 0, so the size gate did not fire and
 * `readFileSync` blocked FOREVER: measured, `mkfifo site.css` in a project made
 * the whole app hang, no repaint, no IPC, the write neither completing nor
 * refusing. Only a regular file is read; anything else with a matching name is
 * something this scan cannot account for, so it contributes ANY.
 *
 * THE WHOLE PROJECT, not `src` plus the three stylesheet roots. Whose
 * stylesheet a page actually imports is a question about module resolution, and
 * answering it wrongly is the one direction that loses bytes -- measured, an
 * `assets/site.css` holding `.preserved { white-space: pre }` and imported from
 * a page's frontmatter sat outside every scanned root and answered `[]`. The
 * superset is sound for a question only ever read as NO, and `SKIP_DIRS` keeps
 * it off the build output and the dependency tree.
 */
function sourcesOf(projectPath) {
  const files = [];
  let failed = false;
  const walked = new Set();
  // The bound, spent across the whole walk rather than per directory. `stopped`
  // is separate from `failed` because the walk has to unwind out of every
  // recursion once the budget is gone, not merely record that it was.
  let seen = 0;
  let stopped = false;
  const deadline = Date.now() + MAX_MS;
  // A path that will not resolve leaves `root` as the written one, which the
  // `readdirSync` below then fails on in the one place that reports it.
  let root;
  try {
    root = fs.realpathSync(projectPath);
  } catch {
    root = path.resolve(projectPath);
  }
  const inside = (real) => real === root || real.startsWith(root + path.sep);
  const walk = (dir, depth) => {
    if (stopped) return;
    if (depth > MAX_DEPTH) {
      failed = true;
      return;
    }
    // Keyed on the resolved path so a link and its target, or two links to one
    // shared directory, are one directory. A path that will not resolve is left
    // to `readdirSync` below, which reports the same failure in one place.
    try {
      const real = fs.realpathSync(dir);
      if (walked.has(real)) return;
      walked.add(real);
    } catch {
      /* handled by the read below */
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (MISSING(err)) return;
      failed = true;
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES || Date.now() > deadline) {
        failed = true;
        stopped = true;
        return;
      }
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let what = entry;
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(full);
        } catch (err) {
          if (!MISSING(err)) failed = true;
          continue;
        }
        // The link leaves the project. Not followed, and NOT silently dropped:
        // whatever rules are over there went unread, and unread is ANY.
        if (!inside(real)) {
          failed = true;
          continue;
        }
        try {
          what = fs.statSync(full);
        } catch (err) {
          if (!MISSING(err)) failed = true;
          continue;
        }
      }
      if (what.isDirectory()) walk(full, depth + 1);
      else if (!SOURCE_FILE.test(entry.name)) continue;
      else if (what.isFile()) {
        files.push(full);
        // The cap on the WORK, spent here because this is the only place that
        // knows how much of it there will be -- see `MAX_FILES`. Duplicates
        // are still in the list at this point, so this can stop a walk slightly
        // early; erring towards the sentinel is the direction that keeps bytes.
        if (files.length > MAX_FILES) {
          failed = true;
          stopped = true;
          return;
        }
      } else failed = true;
    }
  };
  walk(projectPath, 0);
  return { files: [...new Set(files)].sort(), failed };
}

// The last answer, and the stamp it was computed from. A page:write asks this
// on every save and the answer changes only when a file does, so the scan is
// keyed on the same thing a rebuild would be: every candidate file's path, size
// and mtime.
let cached = null;
// How many times the scan has actually run, for a test that needs to know the
// cache hit rather than assume it.
let scans = 0;

const hash = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');

/**
 * The text of one file the caller already holds, or null.
 *
 * THE PAGE BEING WRITTEN IS ONE OF THE FILES THIS SCAN COVERS, which is why the
 * cache never hit. `page:write` asks for the tokens and then changes the page's
 * bytes, so save N moved the page's size and mtime and save N+1 missed on its
 * own stamp: measured, files read during `preservingTokens` were 3, 3, 3, 3, 3
 * across five consecutive saves -- a full synchronous re-read and postcss
 * re-parse of every stylesheet on the main process, every save.
 *
 * Dropping the page from the scan is not the fix: its own `<style>` block
 * styles its own elements, and losing those rules is the byte-losing
 * direction. So the caller hands in the text it already read, and that file is
 * stamped by the HASH OF WHAT THIS SCAN READS OF IT (`readableTexts`) instead
 * of by size and mtime. A save that leaves the style block alone therefore hits
 * the cache, and one that edits it still misses.
 */
function knownTextOf(known, abs) {
  if (!known) return null;
  const text = known.get(abs);
  return typeof text === 'string' ? text : null;
}

function stampOf(files, known) {
  const parts = [];
  for (const abs of files) {
    const text = knownTextOf(known, abs);
    if (text !== null) {
      parts.push(`${abs}:text:${hash(JSON.stringify(readableTexts(abs, text)))}`);
      continue;
    }
    try {
      const st = fs.statSync(abs);
      parts.push(`${abs}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${abs}:gone`);
    }
  }
  return parts.join('|');
}

/** `options.knownText` as a map keyed the way the walk keys its files. */
function knownMap(options) {
  const given = options && typeof options === 'object' ? options.knownText : null;
  if (!given || typeof given !== 'object') return null;
  const map = new Map();
  for (const [key, value] of Object.entries(given)) {
    if (typeof key === 'string' && typeof value === 'string') map.set(path.resolve(key), value);
  }
  return map.size ? map : null;
}

/**
 * The token set for one project, or a set holding only ANY when the project
 * cannot be scanned at all.
 *
 * Never throws and never returns null: a caller that gets a set has an answer
 * it can act on, and the answer to A SCAN THAT WENT WRONG — a directory it
 * could not read, a stylesheet too big to parse, a file it does not know how to
 * parse — is the one that refuses reindentation rather than the one that
 * permits it.
 *
 * "No project to scan" is NOT one of those and is answered the other way, on
 * purpose: see the first line of the function. A review read this paragraph as
 * covering that case too, which it used to.
 */
function preservingTokens(projectPath, options = {}) {
  // NO PROJECT IS NOT A FAILED SCAN, AND THE TWO GET OPPOSITE ANSWERS.
  //
  // Everything below that cannot be read contributes ANY, which REFUSES
  // reindentation. This line does the opposite deliberately: a caller with no
  // project to scan has no project whose rules could be broken, and answering
  // ANY here would switch the guard off for every such caller rather than
  // narrowing anything. test/source-fidelity-matrix.js asserts it by name.
  //
  // A review read the docstring above as promising ANY here too, which is what
  // that paragraph used to say; the paragraph is what was too broad, and it now
  // says which "went wrong" it means.
  if (!projectPath || typeof projectPath !== 'string') return new Set();
  const known = knownMap(options);
  let scan;
  try {
    scan = sourcesOf(projectPath);
  } catch {
    return new Set([ANY]);
  }
  const readStart = Date.now();
  const stamp = `${projectPath}\n${scan.failed ? 'unwalkable\n' : ''}${stampOf(scan.files, known)}`;
  if (cached && cached.stamp === stamp) return cached.tokens;
  scans += 1;

  const tokens = new Set();
  // A PART OF THE TREE NOBODY LOOKED AT IS NOT A PART OF THE TREE WITH NO RULES
  // IN IT. A directory that would not list, or one below the depth cap, takes
  // every stylesheet under it out of the file list, and an empty list is the
  // positive answer "nothing here preserves whitespace".
  if (scan.failed) tokens.add(ANY);
  // Started after the walk, which spends a budget of its own, and covering the
  // stamp's stats as well as the reads: a stamp that already took the whole
  // budget leaves the first file to trip this, which is the honest answer
  // rather than a partial one. See `MAX_READ_MS`.
  const deadline = readStart + MAX_READ_MS;
  for (const abs of scan.files) {
    // A FILE THIS RAN OUT OF TIME FOR IS A FILE NOBODY READ. Stopping here and
    // keeping the tokens gathered so far would hand back a SHORTER answer that
    // reads as a complete one; the sentinel is what makes it "I cannot tell".
    if (Date.now() > deadline) {
      tokens.add(ANY);
      break;
    }
    let text = knownTextOf(known, abs);
    if (text === null) {
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
    }
    for (const one of readableTexts(abs, text)) {
      for (const token of tokensInCss(one)) tokens.add(token);
    }
  }
  cached = { stamp, tokens };
  return tokens;
}

/** For a test that needs the next call to do the work again. */
function forgetCache() {
  cached = null;
}

/** How many scans have actually run, so a test can measure a cache hit. */
function scansSoFar() {
  return scans;
}

module.exports = {
  preservingTokens,
  tokensInCss,
  styleBlocksIn,
  forgetCache,
  scansSoFar,
};
