import React from 'react';
import { ReviewStatusDot, statusWord } from '../ui/ReviewThread.jsx';

// Which review, when several are in the same place.
//
// The old behaviour opened the first one. That is a coin toss presented as a
// decision: two people leaving notes on the same heading get one of them read
// and the other silently skipped, and nothing on screen says the second exists.
//
// So a cluster asks. It is selection only — status, number, one line each —
// and choosing takes you to the Inspector, which is where reviews are read.
// There is no conversation in here, no reply box and no workflow actions,
// because a chooser that could also resolve things is a second Inspector that
// happens to be tiny.

/** Enough to tell two reviews apart on one line. */
const EXCERPT = 60;

/**
 * The chooser, anchored to its cluster.
 *
 * Placement flips near the window edges and the pointer flips with it, so the
 * arrow keeps pointing at the marker this list belongs to — a chooser that
 * detaches from its pin is a list of comments about nothing in particular.
 */
export default function ReviewCluster({ reviews, at, onPick, onClose }) {
  const ref = React.useRef(null);
  const [flip, setFlip] = React.useState({ x: false, y: false });
  const [active, setActive] = React.useState(0);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof window === 'undefined') return;
    const box = node.getBoundingClientRect();
    setFlip({
      x: at.x + 16 + box.width > window.innerWidth - 8,
      y: at.y + 12 + box.height > window.innerHeight - 8,
    });
  }, [at.x, at.y, reviews?.length]);

  const activeRef = React.useRef(null);
  // Focus is on the row itself rather than on the box: these are real buttons,
  // so Enter and Space are the browser's job and the arrows only have to move
  // focus. Esc restores focus to the marker that opened this — see onClose.
  React.useEffect(() => {
    activeRef.current?.focus();
  }, [active]);

  const list = reviews || [];
  const move = (delta) => setActive((i) => (i + delta + list.length) % list.length);

  return (
    <div
      ref={ref}
      className={`review-cluster${flip.x ? ' flip-x' : ''}${flip.y ? ' flip-y' : ''}`}
      style={{ left: at.x, top: at.y }}
      // A small non-modal dialog holding ordinary buttons.
      //
      // It was a listbox whose options were <button>s, which is two widget
      // patterns in one element: a listbox owns its own focus and options are
      // not independently focusable, so nothing could navigate it correctly.
      // Buttons in a labelled dialog need no roving-focus machinery, Tab and
      // Enter already work, and the arrow keys below are an extra rather than
      // the only way in.
      role="dialog"
      aria-modal="false"
      aria-label={`${list.length} comments here`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose?.();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
        // Enter and Space are the focused button's own behaviour; adding them
        // here would fire the pick twice.
      }}
    >
      <div className="review-cluster-title">{list.length} comments here</div>
      {/* Native scrolling, and only when a cluster is unusually large. Most
          are two or three. */}
      <div className="review-cluster-list">
        {list.map((r, i) => (
          <button
            key={r.id}
            ref={i === active ? activeRef : null}
            className={`review-cluster-row${i === active ? ' on' : ''}`}
            aria-label={`Comment #${r.number}, ${statusWord(r.status, r.anchorState)}. ${String(r.message || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80)}`}
            onMouseEnter={() => setActive(i)}
            onClick={(e) => {
              e.stopPropagation();
              onPick?.(r.id);
            }}
          >
            <ReviewStatusDot status={r.status} anchorState={r.anchorState} labelled={false} />
            {r.number != null && <span className="review-cluster-n">#{r.number}</span>}
            <span className="review-cluster-text">
              {String(r.message || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
