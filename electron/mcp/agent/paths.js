// Keeping every path argument inside the project.
//
// This is the one piece of the Agent API where a mistake is a security bug
// rather than a wrong edit. Every path an agent sends is project-relative and
// is resolved here; nothing else in the API turns a client's string into a
// filesystem location.
//
// The rules are the boring ones, which is the point:
//
//   relative only     an absolute path is refused outright rather than
//                     "normalized" into something. `/etc/passwd` is not a
//                     typo to be helpful about.
//   resolved, then    `..` is not searched for as text. The path is resolved
//   checked           and the RESULT has to be inside the root — which is the
//                     only check that survives symlinks, encodings and the
//                     `..%2f` family.
//   no root escape    a path that resolves to the root's parent, or to the
//                     root's sibling whose name merely starts the same way, is
//                     out. Hence the separator on the prefix test.
//   posix out         everything the API says back is posix-spelled and
//                     relative, so a Windows separator never leaks into an
//                     answer and neither does anybody's home directory.

const fs = require('node:fs');
const path = require('node:path');

const toPosix = (p) => String(p).split(path.sep).join('/');

/**
 * Resolve a project-relative path, or say why not.
 *
 * Returns `{ ok: true, abs, rel }` or `{ ok: false, code, message }`.
 */
function resolveInProject(root, rel, { what = 'path' } = {}) {
  if (!root) return { ok: false, code: 'no_project', message: 'No project is open in Stacki.' };
  if (typeof rel !== 'string' || !rel.trim()) {
    return { ok: false, code: 'bad_path', message: `A project-relative ${what} is required.` };
  }
  const raw = rel.trim();
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    return {
      ok: false,
      code: 'outside_project',
      message: `${what} must be relative to the open project — Stacki does not take absolute paths.`,
    };
  }
  // A null byte truncates the path at the syscall, so a name containing one
  // can mean a different file than the one that was checked.
  if (raw.includes('\0')) return { ok: false, code: 'bad_path', message: `That ${what} is not a valid filename.` };

  const base = path.resolve(root);
  const abs = path.resolve(base, raw);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, code: 'outside_project', message: `That ${what} is outside the open project.` };
  }
  // And again after following links, so a symlink planted inside the project
  // cannot point out of it. A path that does not exist yet is checked by its
  // nearest existing parent, which is where a new file would actually land.
  const real = realpathOfNearest(abs);
  const realBase = realpathOfNearest(base);
  if (real && realBase && real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { ok: false, code: 'outside_project', message: `That ${what} leads outside the open project.` };
  }
  return { ok: true, abs, rel: toPosix(path.relative(base, abs)) };
}

/** The real path of `abs`, or of the closest ancestor that exists. */
function realpathOfNearest(abs) {
  let at = abs;
  for (let i = 0; i < 64; i++) {
    try {
      return fs.realpathSync(at);
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}

/** A path made relative to the root, posix-spelled. Absolute paths never leave. */
function relativeTo(root, file) {
  if (!file) return null;
  if (!root) return null;
  const rel = path.relative(path.resolve(root), file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? toPosix(rel) : null;
}

module.exports = { resolveInProject, relativeTo, toPosix };
