// What points at an asset, and whether moving it can be done safely.
//
// A live dogfood moved `public/images/hero.png` to `public/media/` through
// Stacki. The file moved. `<img src="/images/hero.png">` on the page did not,
// and neither did the `url(/images/hero.png)` in the stylesheet. The answer was
// `{ok: true}` with no warning and no list — a site broken in two places by an
// operation that reported success.
//
// The same for `src/assets/logo.png`: the ESM import in the page kept pointing
// at a file that is not there, and Stacki's OWN resolver
// (`content.resolve_import`) then answered `path: null` for it. The product
// could see the breakage and still called the move clean.
//
// THE INVARIANT THIS ESTABLISHES. After an operation that changes an asset's
// address, no file in the project may contain a statically resolvable reference
// to the OLD address — either every such reference was rewritten in the same
// operation, or nothing moved at all. `ok: true` from an asset move is a claim
// that this holds.
//
// TWO ADDRESS SPACES, BECAUSE ASTRO HAS TWO ASSET MODELS.
//
//   public/images/hero.png   copied to the site as-is, referenced by URL:
//                            `/images/hero.png`. The `public/` prefix is not
//                            part of the address.
//   src/assets/logo.png      processed by the build, referenced by an ESM
//                            import written RELATIVE TO THE IMPORTING FILE —
//                            so the same asset is `../assets/logo.png` from a
//                            page and `./logo.png` from a sibling.
//
// WHAT IS AND IS NOT PROVABLE. A reference is rewritten only when the address
// appears literally. `src={"/images/" + name}` and `import.meta.glob` are real
// ways to reference an asset and there is no honest way to rewrite them, so
// they are found, reported, and the move is REFUSED rather than half-done. A
// half-done move is the defect wearing a different hat.

const fs = require('node:fs');
const path = require('node:path');

const toPosix = (p) => String(p).split(path.sep).join('/');

// Where to look. Everything the build reads, and nothing it writes.
const SCAN_DIRS = ['src', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.vercel', '.netlify', 'build', 'out']);

// Files that can hold a reference. A binary cannot, and reading one to search
// it for a path is how a scan comes to take a minute on a project with photos.
const TEXTUAL = /\.(astro|md|mdx|markdown|html|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|json|svg|vue|svelte)$/i;

// A file large enough that it is data rather than source.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// A project big enough that scanning it is its own problem. Well past any real
// `src/`, and it is a bound rather than a guess: past it the answer is "this
// could not be established", never "there are no references".
const MAX_FILES = 4000;

/** Every textual file under the project's own directories. */
function textualFiles(projectPath) {
  const out = [];
  let truncated = false;
  const walk = (dir, rel) => {
    if (truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, relPath);
        continue;
      }
      if (!TEXTUAL.test(entry.name)) continue;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      if (out.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      out.push({ abs: full, rel: relPath });
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(projectPath, dir), dir);
  return { files: out, truncated };
}

/** Which root a rooted rel is under: `public` or `src`. */
const rootOf = (rel) => String(rel).split('/')[0];

/**
 * The site URL a public asset is served at.
 *
 * `public/images/hero.png` -> `/images/hero.png`. Null for anything not under
 * public/, which has no URL of its own.
 */
function publicUrlOf(rel) {
  const posix = toPosix(rel);
  return posix.startsWith('public/') ? `/${posix.slice('public/'.length)}` : null;
}

/** Escape a string for use as a literal in a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An import specifier that resolves to `targetRel` from `fromRel`.
 *
 * Both spellings a person writes: `../assets/logo.png` and `./logo.png`. The
 * leading `./` is required — a bare `assets/logo.png` is a bare specifier and
 * resolves against node_modules, not against the file.
 */
function specifierFor(fromRel, targetRel) {
  const dir = path.posix.dirname(toPosix(fromRel));
  let spec = path.posix.relative(dir, toPosix(targetRel));
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

/**
 * Whether a line references the asset in a way this cannot rewrite.
 *
 * Deliberately narrow: it looks for the asset's DIRECTORY or BASENAME inside an
 * expression, which is how a built address is nearly always assembled. A false
 * positive costs a refusal the person can override by moving the file
 * themselves; a false negative costs a broken site, which is what this exists
 * to prevent.
 */
function dynamicMention(line, address, basename) {
  // The literal is there, so it is rewritable and this is not that.
  if (line.includes(address)) return false;
  const dir = address.slice(0, address.lastIndexOf('/') + 1);
  const mentions = (dir.length > 1 && line.includes(dir)) || line.includes(basename);
  if (!mentions) return false;

  // AND AN ACTUAL CONSTRUCTION, not merely a brace on the line. The first
  // version of this asked whether the line contained `{` or a backtick, which
  // is true of every CSS rule ever written: `.hero { background:
  // url(/images/hero.png) }` was reported as a runtime-built reference, and
  // moving an unrelated asset in the same directory was refused because of it.
  //
  // What actually builds an address is an interpolation, a concatenation, or a
  // glob. Each is a token, and each is looked for as one.
  const interpolated = line.includes('${');
  const concatenated = /['"`][^'"`]*['"`]\s*\+|\+\s*['"`]/.test(line);
  const globbed = /import\.meta\.glob\s*\(/.test(line);
  return interpolated || concatenated || globbed;
}

/**
 * Every statically provable reference to `assetRel`, and every place that looks
 * like it builds one at runtime.
 *
 * `assetRel` is a rooted project-relative path — `public/images/hero.png` or
 * `src/assets/logo.png`.
 */
function referencesTo(projectPath, assetRel) {
  const rel = toPosix(assetRel);
  const basename = path.posix.basename(rel);
  const url = publicUrlOf(rel);
  const isSrc = rootOf(rel) === 'src';

  const { files, truncated } = textualFiles(projectPath);
  const refs = [];
  const dynamic = [];

  for (const file of files) {
    // The asset itself is not a reference to itself.
    if (file.rel === rel) continue;
    let text;
    try {
      text = fs.readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }

    // The addresses this file could use for the asset.
    const addresses = [];
    if (url) addresses.push({ address: url, kind: 'url' });
    if (isSrc) {
      // Both spellings resolve to the same file; a project may use either.
      const spec = specifierFor(file.rel, rel);
      addresses.push({ address: spec, kind: 'import' });
      // And the project-root-absolute spelling some setups use.
      addresses.push({ address: `/${rel}`, kind: 'import' });
    }

    const lines = text.split('\n');
    for (const { address, kind } of addresses) {
      if (!text.includes(address)) continue;
      // A URL is a prefix of a longer one: `/img/a.png` must not match
      // `/img/a.png.bak`, and `/img/a` must not match `/img/ab.png`. The
      // character after it has to end the reference.
      const boundary = new RegExp(`${escapeRe(address)}(?![\\w.-])`, 'g');
      lines.forEach((line, i) => {
        boundary.lastIndex = 0;
        if (!boundary.test(line)) return;
        refs.push({ file: file.rel, line: i + 1, kind, address, text: line.trim().slice(0, 200) });
      });
    }

    // And the ones nothing can rewrite.
    const probe = url || `/${rel}`;
    lines.forEach((line, i) => {
      if (dynamicMention(line, probe, basename)) {
        dynamic.push({ file: file.rel, line: i + 1, text: line.trim().slice(0, 200) });
      }
    });
  }

  return { refs, dynamic, scanned: files.length, truncated };
}

/**
 * Rewrite every provable reference from one address to another, all or nothing.
 *
 * `plan()` first, so a caller can refuse before the asset moves. `apply()`
 * writes, and restores every file it had already written if one of them fails —
 * a partial rewrite is a site broken in a new place, which is worse than the
 * one this is fixing.
 */
function plan(projectPath, fromRel, toRel) {
  const found = referencesTo(projectPath, fromRel);
  const from = toPosix(fromRel);
  const to = toPosix(toRel);
  const fromUrl = publicUrlOf(from);
  const toUrl = publicUrlOf(to);
  const isSrc = rootOf(from) === 'src';

  const edits = new Map(); // file rel -> { abs, before, after }
  for (const ref of found.refs) {
    const abs = path.join(projectPath, ref.file);
    let before = edits.get(ref.file)?.after;
    if (before === undefined) {
      try {
        before = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
    }
    let next = before;
    if (ref.kind === 'url' && fromUrl && toUrl) {
      next = before.replace(new RegExp(`${escapeRe(fromUrl)}(?![\\w.-])`, 'g'), toUrl);
    } else if (ref.kind === 'import') {
      if (ref.address === `/${from}`) {
        next = before.replace(new RegExp(`${escapeRe(`/${from}`)}(?![\\w.-])`, 'g'), `/${to}`);
      } else if (isSrc) {
        const oldSpec = specifierFor(ref.file, from);
        const newSpec = specifierFor(ref.file, to);
        next = before.replace(new RegExp(`${escapeRe(oldSpec)}(?![\\w.-])`, 'g'), newSpec);
      }
    }
    const original = edits.get(ref.file)?.before ?? before;
    edits.set(ref.file, { abs, before: original, after: next });
  }

  const changed = [...edits.entries()]
    .filter(([, e]) => e.before !== e.after)
    .map(([rel, e]) => ({ rel, abs: e.abs, before: e.before, after: e.after }));

  return { ...found, edits: changed, from, to };
}

/**
 * Write the plan.
 *
 * `markWrite` is main's `markSelfWrite`, passed in so this module needs no
 * Electron and can be tested without one.
 */
function apply(planned, markWrite = () => {}) {
  const written = [];
  try {
    for (const edit of planned.edits) {
      markWrite(edit.abs);
      fs.writeFileSync(edit.abs, edit.after, 'utf8');
      written.push(edit);
    }
  } catch (err) {
    // ALL OR NOTHING. Whatever landed goes back before the error is reported,
    // because a project with three of five references rewritten is broken in a
    // way nobody asked for and nothing recorded.
    for (const edit of written) {
      try {
        markWrite(edit.abs);
        fs.writeFileSync(edit.abs, edit.before, 'utf8');
      } catch {
        /* nothing more this can do; the throw below carries the failure */
      }
    }
    return { ok: false, error: err.message, rewritten: [] };
  }
  return { ok: true, rewritten: written.map((e) => e.rel) };
}

/** Put a plan back, for an undo. */
function revert(planned, markWrite = () => {}) {
  for (const edit of planned.edits) {
    try {
      markWrite(edit.abs);
      fs.writeFileSync(edit.abs, edit.before, 'utf8');
    } catch {
      /* best effort: the caller's own undo reports what it could not do */
    }
  }
}

module.exports = {
  referencesTo,
  plan,
  apply,
  revert,
  publicUrlOf,
  specifierFor,
  MAX_FILES,
};
