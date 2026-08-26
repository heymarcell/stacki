// The four formatting shortcuts, on a plain textarea.
//
// The composer stays plain text on purpose. What somebody types is what the
// store holds, byte for byte, because a review thread is also an API surface
// an agent reads back — a rich-text editor would put a document model between
// the words and the file, and the agent would get the model's idea of what was
// written rather than the writing.
//
// So this is the smallest thing that helps: ⌘B, ⌘I, ⌘E and ⌘K wrap the
// selection in the characters somebody would otherwise type. Nothing else. No
// toolbar, no autocomplete, no list continuation — each of those is a rule
// about what you meant, and getting one wrong in the middle of a sentence is
// worse than not having it.
//
// Pure, and separate from the component, so the rules can be tested as rules.

/** What each shortcut wraps with, and what to call an empty one. */
const WRAPS = {
  b: { before: '**', after: '**', placeholder: 'bold' },
  i: { before: '*', after: '*', placeholder: 'italic' },
  e: { before: '`', after: '`', placeholder: 'code' },
  k: { before: '[', after: '](url)', placeholder: 'text', select: 'url' },
};

/**
 * Work out what a formatting shortcut should do to the text.
 *
 * Answers `null` when the key is not one of these, so a caller can let every
 * other keystroke through untouched — including ⌘A, ⌘C and the rest, which a
 * greedy handler would swallow.
 *
 * @param {object} state  {value, selectionStart, selectionEnd}
 * @param {object} event  {key, metaKey, ctrlKey, altKey}
 * @returns {{value: string, selectionStart: number, selectionEnd: number}|null}
 */
export function applyMarkdownKey(state, event) {
  if (!event || (!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  const wrap = WRAPS[String(event.key || '').toLowerCase()];
  if (!wrap) return null;

  const value = String(state?.value ?? '');
  const start = Math.max(0, Math.min(value.length, state?.selectionStart ?? 0));
  const end = Math.max(start, Math.min(value.length, state?.selectionEnd ?? start));
  const selected = value.slice(start, end);

  // Already wrapped in the same characters? Take them off again. Pressing ⌘B
  // twice should leave the text as it was, not `****bold****`.
  const before = value.slice(Math.max(0, start - wrap.before.length), start);
  const after = value.slice(end, end + wrap.after.length);
  if (selected && before === wrap.before && after === wrap.after) {
    const cut = value.slice(0, start - wrap.before.length) + selected + value.slice(end + wrap.after.length);
    return { value: cut, selectionStart: start - wrap.before.length, selectionEnd: end - wrap.before.length };
  }

  const body = selected || wrap.placeholder;
  const next = value.slice(0, start) + wrap.before + body + wrap.after + value.slice(end);

  // Where to leave the caret. For a link with text already selected the useful
  // place is the url, because that is the part still missing.
  if (wrap.select === 'url' && selected) {
    const at = start + wrap.before.length + body.length + 2; // past "](", onto "url"
    return { value: next, selectionStart: at, selectionEnd: at + 3 };
  }
  const bodyAt = start + wrap.before.length;
  return { value: next, selectionStart: bodyAt, selectionEnd: bodyAt + body.length };
}

export default applyMarkdownKey;
