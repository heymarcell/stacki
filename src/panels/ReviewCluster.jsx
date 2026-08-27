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

  const listRef = React.useRef(null);
  const rows = () => [...(listRef.current?.querySelectorAll('.review-cluster-row') || [])];

  // Focus is on the row itself rather than on the box: these are real buttons,
  // so Enter and Space are the browser's job and the arrows only have to move
  // focus. Esc restores focus to the marker that opened this — see onClose.
  //
  // ONCE, on opening. It used to run on every change of `active`, and `active`
  // was also what a mouse set on hover — so moving the pointer across the list
  // moved KEYBOARD focus, row by row, under a person who had not touched the
  // keyboard. Someone reading with a screen reader had the pointer drag their
  // focus out from under them; anyone mid-Tab lost their place to a stray
  // mouse. A pointer says what it is over. It does not say where the keyboard
  // is.
  //
  // So there is one focus model here, and it is the DOM's: the arrows move
  // focus, focus reports back as `active`, and hover is a hover.
  React.useEffect(() => {
    rows()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = reviews || [];
  /** Move keyboard focus by `delta` rows, wrapping — the arrows' whole job. */
  const move = (delta) => {
    const items = rows();
    if (!items.length) return;
    // Where focus actually is, not where this component last thought it was.
    const from = items.indexOf(typeof document === 'undefined' ? null : document.activeElement);
    const base = from >= 0 ? from : active;
    items[(base + delta + items.length) % items.length]?.focus();
  };

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
      <div className="review-cluster-list" ref={listRef}>
        {list.map((r, i) => (
          <button
            key={r.id}
            className={`review-cluster-row${i === active ? ' on' : ''}`}
            aria-label={`Comment #${r.number}, ${statusWord(r.status, r.anchorState)}. ${String(r.message || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 80)}`}
            // Which row is marked follows the keyboard, and only the keyboard.
            // Hover has its own appearance in CSS, which is what a pointer is
            // entitled to say.
            onFocus={() => setActive(i)}
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
