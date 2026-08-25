// Where the canvas selection is, in source.
//
// The editing-hierarchy trail that leads to what is selected: the page, then
// the instance of each component drilled into on the way down, then the node
// itself. Each entry is a place in a file — that trail is the one thing an
// agent reading the project cannot work out for itself.
//
// Lifted out of main.js so the two things that need it can share it: ⇧⌘C,
// which writes it to the clipboard as `<file>:<lines>` text, and the MCP
// server, which hands the same trail over as structured data. One resolver,
// so the two can never drift into disagreeing about where the selection is.

const path = require('path');

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Resolve `<file>#<indexPath>` node keys to places in the project.
 *
 * `locate` is astroParser's `locateSelection` — passed in rather than required
 * here so this stays a pure function of its inputs and can be tested without
 * a project on disk.
 *
 * Returns `[{ file, startLine, endLine }]`, project-relative and posix-spelled,
 * or null when there is nothing to point at. A node with no range of its own
 * comes back as a bare file (`startLine` null), which is what the parser says
 * about an unrepresentable file or a path that no longer resolves.
 */
function selectionTrail(state, locate) {
  if (!state || !state.projectPath || !Array.isArray(state.keys)) return null;
  if (typeof locate !== 'function') return null;
  const root = path.resolve(state.projectPath);
  const trail = [];
  for (const key of state.keys) {
    const hash = typeof key === 'string' ? key.indexOf('#') : -1;
    if (hash === -1) continue;
    // The key's file half is renderer input; keep it inside the project.
    const abs = path.resolve(root, key.slice(0, hash));
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    const at = locate(abs, key.slice(hash + 1));
    if (!at) continue;
    trail.push({
      file: toPosix(path.relative(root, at.file)),
      startLine: at.startLine ?? null,
      endLine: at.endLine ?? null,
    });
  }
  return trail.length ? trail : null;
}

/** One `<file>`, `<file>:<line>` or `<file>:<from>-<to>` pointer per entry. */
function formatEntry(entry) {
  if (!entry) return '';
  if (entry.startLine == null) return entry.file;
  if (entry.startLine === entry.endLine) return `${entry.file}:${entry.startLine}`;
  return `${entry.file}:${entry.startLine}-${entry.endLine}`;
}

/** The trail as the lines ⇧⌘C puts on the clipboard. */
const formatTrail = (trail) => (trail || []).map(formatEntry).join('\n');

module.exports = { selectionTrail, formatEntry, formatTrail };
