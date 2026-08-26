import React from 'react';
import ReviewThread from '../ui/ReviewThread.jsx';
import { INSPECTOR_MIN, INSPECTOR_MAX, INSPECTOR_DEFAULT, clampInspector } from '../reviewLayout.js';

// Where a review is read and acted on.
//
// One surface, reached one way: click a pin, click a row, choose from a
// cluster. It is not a bigger version of something else and there is no
// smaller version of it — the old model had a card on the canvas for short
// threads and a panel for long ones, chosen by counting messages, which meant
// the same click did two different things for reasons nobody could see.
//
// It is a panel, not a window. It does not float over the design, cannot be
// dragged, and has no scrollbar of its own — the conversation inside it has
// one, and that is the only thing that scrolls.
//
// The divider is the one drag gesture left in the whole reading workflow.

/**
 * Drag the edge.
 *
 * Pointer-captured, and the width goes onto a CSS variable during the gesture
 * rather than into React state: the conversation inside can be two thousand
 * words of Markdown, and re-rendering it once per pointer pixel is exactly the
 * cost this avoids. React is told once, at the end.
 */
function useInspectorResize({ width, onCommit }) {
  const shellRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);

  const start = (e) => {
    if (e.button !== 0) return;
    const shell = shellRef.current;
    if (!shell) return;
    const from = { x: e.clientX, w: shell.getBoundingClientRect().width };
    const handle = e.currentTarget;
    e.preventDefault();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that cannot be captured still drags; it just is not exclusive */
    }
    setDragging(true);

    let queued = false;
    let frame = 0;
    let pending = from.w;
    const paint = () => {
      queued = false;
      frame = 0;
      shell.style.setProperty('--inspector-w', `${Math.round(pending)}px`);
    };

    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      pending = clampInspector(from.w + (ev.clientX - from.x));
      if (!queued) {
        queued = true;
        frame = requestAnimationFrame(paint);
      }
    };
    const finish = (ev) => {
      if (ev && ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      if (queued) {
        if (frame) cancelAnimationFrame(frame);
        paint();
      }
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      setDragging(false);
      shell.style.removeProperty('--inspector-w');
      onCommit(clampInspector(pending));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  return { shellRef, dragging, start };
}

/**
 * @param {object} props
 * @param {number} props.width       what the layout decided it gets
 * @param {boolean} props.resizable  false in overlay mode, where there is
 *                                   nothing to take space from
 */
export default function ReviewInspector({
  review,
  width = INSPECTOR_DEFAULT,
  resizable = true,
  onWidthChange,
  onBack,
  ...thread
}) {
  const { shellRef, dragging, start } = useInspectorResize({ width, onCommit: onWidthChange });

  return (
    <section
      ref={shellRef}
      className={`review-inspector${dragging ? ' is-resizing' : ''}`}
      style={{ '--inspector-w': `${width}px` }}
      aria-label={review?.number != null ? `Comment #${review.number}` : 'Comment'}
    >
      <ReviewThread review={review} onBack={onBack} {...thread} />
      {resizable && (
        <div
          className="review-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the comment reader"
          aria-valuemin={INSPECTOR_MIN}
          aria-valuemax={INSPECTOR_MAX}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={start}
          onDoubleClick={() => onWidthChange(INSPECTOR_DEFAULT)}
          onKeyDown={(e) => {
            // Separator semantics: the arrows move it, Home and End take it to
            // the ends, Enter puts it back where it started.
            const step = e.shiftKey ? 40 : 10;
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onWidthChange(clampInspector(width - step));
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              onWidthChange(clampInspector(width + step));
            } else if (e.key === 'Home') {
              e.preventDefault();
              onWidthChange(INSPECTOR_MIN);
            } else if (e.key === 'End') {
              e.preventDefault();
              onWidthChange(INSPECTOR_MAX);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onWidthChange(INSPECTOR_DEFAULT);
            }
          }}
        />
      )}
    </section>
  );
}
