// Comment mode, as a rule rather than as a pile of useState.
//
// A mode that changes what a click means is the easiest thing in an editor to
// get subtly wrong: it sticks when it should have let go, it eats a click it
// should have passed on, or it fires from a keystroke somebody was typing into
// a field. All three are one-line mistakes and none of them show up in a
// screenshot, so the rule lives here on its own where it can be checked
// against a table of events instead of by clicking around.
//
// The shape of it:
//
//   off        normal Stacki. Clicks select and edit as they always did.
//   armed      C was pressed. The next click on something selectable picks a
//              target instead of editing it.
//   composing  a target was picked; the box is open and waiting for words.
//
// Escape steps back one rung rather than dropping everything, because the two
// things it could mean — "not that element" and "I'm done commenting" — are
// different and a person means the first one far more often.

export const OFF = 'off';
export const ARMED = 'armed';
export const COMPOSING = 'composing';

export const initialReviewMode = { phase: OFF, target: null };

/**
 * Whether a key event is somebody typing rather than somebody pressing a
 * shortcut.
 *
 * Stacki's existing guards check inputs, textareas, selects and contenteditable;
 * two more are named here because both are places people type a lot and
 * neither is an `<input>`: CodeMirror, which is a contenteditable div inside
 * `.cm-editor`, and the terminal, which is an off-screen textarea inside
 * `.xterm`. A `c` swallowed into a shell command, or a review opened because
 * somebody typed "color" into the CSS editor, is the same bug twice.
 */
export function isTextEntry(el) {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  return !!el.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, .xterm, .terminal'
  );
}

/**
 * Whether this keydown means "comment mode".
 *
 * A bare C. No modifier of any kind: ⌘C copies the selected node, ⌥C opens the
 * CMS panel, and ⇧C is the pin toggle below — each of those already means
 * something, and a shortcut that fires for all four would break three features
 * to add one.
 */
export function isCommentModeKey(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return e.key === 'c' || e.key === 'C';
}

/** ⇧C — show or hide the pins. */
export function isPinToggleKey(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey || !e.shiftKey) return false;
  return e.key === 'C' || e.key === 'c';
}

/**
 * The next mode, given what happened.
 *
 * Every event that can move it is here, including the ones that come from
 * somewhere else in the app — a page change, a project closing — because a
 * composer still floating over a page nobody is on any more is the sort of
 * thing that only gets noticed by the person it happens to.
 */
export function reviewModeReducer(state = initialReviewMode, event = {}) {
  const phase = state?.phase || OFF;
  switch (event.type) {
    case 'toggle':
      return phase === OFF ? { phase: ARMED, target: null } : { phase: OFF, target: null };
    case 'enter':
      return phase === OFF ? { phase: ARMED, target: null } : state;
    case 'exit':
      return phase === OFF ? state : { phase: OFF, target: null };
    case 'target':
      // A click with nothing behind it — the canvas could not name what was
      // under the pointer — leaves the mode armed rather than opening a box
      // with nothing to attach it to.
      if (phase === OFF || !event.target) return state;
      return { phase: COMPOSING, target: event.target };
    case 'submitted':
      // One comment, then back to editing. Staying armed reads as normal until
      // the next click quietly becomes a second comment.
      return { phase: OFF, target: null };
    case 'escape':
      // Step back one rung: not that element, then not commenting.
      if (phase === COMPOSING) return { phase: ARMED, target: null };
      if (phase === ARMED) return { phase: OFF, target: null };
      return state;
    case 'file-changed':
      // Drilled into a component, or backed out of one. The page on the canvas
      // has not moved and neither has the intent to comment — but a target
      // picked in the file just left is a node id from a tree that is no longer
      // loaded, so the composer goes and the mode stays.
      return phase === COMPOSING ? { phase: ARMED, target: null } : state;
    case 'context-lost':
      // The page changed, the project closed, the preview went away. Whatever
      // was being written was about something that is no longer on screen.
      return phase === OFF ? state : { phase: OFF, target: null };
    default:
      return state;
  }
}

/** Whether a click on the canvas should be taken as picking a comment target. */
export const wantsCanvasClick = (state) => state?.phase === ARMED;

/** Whether the composer is up. */
export const isComposing = (state) => state?.phase === COMPOSING;

/** Whether comment mode is on at all — what the cursor and the button follow. */
export const isCommenting = (state) => state?.phase !== OFF;

/**
 * Where in an element's box a click landed, as ratios.
 *
 * Ratios rather than page coordinates so the pin moves with the element: a
 * section that grows by 200px keeps its comment on the paragraph it was left
 * on, instead of 200px above it. A box with no size (an inline element that
 * measured to nothing) has no meaningful point in it, so the middle is used.
 */
export function pinRatios(point, rect) {
  const w = Number(rect?.w ?? rect?.width) || 0;
  const h = Number(rect?.h ?? rect?.height) || 0;
  if (!w || !h || !point) return { xRatio: 0.5, yRatio: 0.5 };
  const clamp = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return {
    xRatio: clamp((Number(point.x) - (Number(rect.x) || 0)) / w),
    yRatio: clamp((Number(point.y) - (Number(rect.y) || 0)) / h),
  };
}

export default reviewModeReducer;
