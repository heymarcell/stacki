// What actually changed on disk, in a few lines.
//
// A mutation that answers "ok" and nothing else is a mutation an agent has to
// verify by reading the file back — which is the round trip this whole feature
// exists to remove. So every write says what it did, as a patch.
//
// Bounded, hard. A raw source write can replace a thousand-line file, and a
// tool result that carries the whole of it costs more than the read it saved.
// So: only the hunks that differ, only a few of them, and a count of what was
// left out. The digests beside it are the exact answer for anybody who needs
// one; the patch is for reading.

const MAX_HUNKS = 6;
const MAX_HUNK_LINES = 40;
const CONTEXT = 2;

/**
 * A unified-ish diff of two texts.
 *
 * Not a real Myers diff: it walks in from both ends to find the changed middle,
 * which is exactly right for the edits this API makes (one node's text, one
 * declaration, one attribute) and degrades to "these lines became those lines"
 * for anything larger. A tool result is not a merge tool.
 */
function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === a.length && head === b.length) return [];
  return [
    {
      startLine: head + 1,
      removed: a.slice(head, a.length - tail),
      added: b.slice(head, b.length - tail),
      context: {
        before: a.slice(Math.max(0, head - CONTEXT), head),
        after: a.slice(a.length - tail, Math.min(a.length, a.length - tail + CONTEXT)),
      },
    },
  ];
}

/** One hunk as text, capped. */
function renderHunk(hunk) {
  const lines = [];
  for (const line of hunk.context.before) lines.push(`  ${line}`);
  let shown = 0;
  for (const line of hunk.removed) {
    if (shown >= MAX_HUNK_LINES) break;
    lines.push(`- ${line}`);
    shown++;
  }
  const removedOmitted = Math.max(0, hunk.removed.length - shown);
  if (removedOmitted) lines.push(`… ${removedOmitted} more removed line${removedOmitted === 1 ? '' : 's'}`);
  shown = 0;
  for (const line of hunk.added) {
    if (shown >= MAX_HUNK_LINES) break;
    lines.push(`+ ${line}`);
    shown++;
  }
  const addedOmitted = Math.max(0, hunk.added.length - shown);
  if (addedOmitted) lines.push(`… ${addedOmitted} more added line${addedOmitted === 1 ? '' : 's'}`);
  for (const line of hunk.context.after) lines.push(`  ${line}`);
  return { at: hunk.startLine, text: lines.join('\n') };
}

/**
 * The patch between two versions of a file.
 *
 * Null when nothing changed — which is a real answer, and a more useful one
 * than an empty string: a write that produced identical bytes did nothing, and
 * an agent should be told so rather than shown a blank diff.
 */
function patchBetween(before, after) {
  if (before === after) return null;
  const hunks = diffLines(before, after).slice(0, MAX_HUNKS);
  if (!hunks.length) return null;
  return {
    hunks: hunks.map(renderHunk),
    linesRemoved: hunks.reduce((n, h) => n + h.removed.length, 0),
    linesAdded: hunks.reduce((n, h) => n + h.added.length, 0),
  };
}

module.exports = { patchBetween, diffLines, MAX_HUNKS, MAX_HUNK_LINES };
