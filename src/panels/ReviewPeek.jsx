import React from 'react';
import { ReviewStatusDot, authorLabel } from '../ui/ReviewThread.jsx';

// What a pin is, before you commit to opening it.
//
// A pin says WHERE. Until now, finding out WHAT it said meant opening the
// whole conversation on top of the design — so people opened reviews to
// identify them and then closed them again. Peek answers that question without
// the trip.
//
// It is deliberately not a small conversation window. It has no controls, no
// composer, no links, no scrolling, and `pointer-events: none` — the pointer
// goes straight through it to the pin and the page underneath. Anything you
// could click in here would be a second, worse way of doing something the
// Inspector already does properly, and a surface that appears on hover and can
// be clicked is a surface that moves away as you reach for it.
//
// Two lines of the first message. Enough to recognise a review; not enough to
// read one, which is the point.

/** Two lines' worth. Clamped in CSS as well; this keeps the DOM small too. */
const PREVIEW_CHARS = 180;

const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

/**
 * The passive preview.
 *
 * `at` is where the pin is in window coordinates. Placement flips near the
 * edges so it is never drawn off screen, and it is measured rather than
 * guessed — a preview clipped by the window is worse than none.
 */
export default function ReviewPeek({ review, at, cluster = 0 }) {
  const ref = React.useRef(null);
  const [flip, setFlip] = React.useState({ x: false, y: false });

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof window === 'undefined') return;
    const box = node.getBoundingClientRect();
    setFlip({
      x: at.x + 16 + box.width > window.innerWidth - 8,
      y: at.y + 12 + box.height > window.innerHeight - 8,
    });
  }, [at.x, at.y, review?.id, cluster]);

  // A cluster has no single thing to preview, so it says how many rather than
  // picking one of them to be the answer.
  if (cluster > 1) {
    return (
      <div
        ref={ref}
        className={`review-peek is-cluster${flip.x ? ' flip-x' : ''}${flip.y ? ' flip-y' : ''}`}
        style={{ left: at.x, top: at.y }}
        role="tooltip"
      >
        <span className="review-peek-count">{cluster} comments here</span>
      </div>
    );
  }

  if (!review) return null;
  const first = (review.messages || [])[0] || null;
  const body = String(first?.body || review.message || '').replace(/\s+/g, ' ').trim();
  const replies = Math.max(0, (review.messages?.length || review.replies + 1 || 1) - 1);
  const who = authorLabel(first || review.author, null);

  return (
    <div
      ref={ref}
      className={`review-peek${flip.x ? ' flip-x' : ''}${flip.y ? ' flip-y' : ''}`}
      style={{ left: at.x, top: at.y }}
      role="tooltip"
      // The whole point of the surface. Without it, moving the pointer across
      // a pin makes the thing you are pointing at disappear from under it.
      aria-hidden="true"
    >
      <div className="review-peek-head">
        <ReviewStatusDot status={review.status} anchorState={review.anchorState} color={review.color} />
        {review.number != null && <span className="review-peek-n">#{review.number}</span>}
        <span className="review-peek-who">{who}</span>
        <span className="review-peek-age">{ago(review.updatedAt || review.createdAt)}</span>
      </div>
      <div className="review-peek-body">{body.slice(0, PREVIEW_CHARS)}</div>
      {replies > 0 && (
        <div className="review-peek-more">
          {replies} {replies === 1 ? 'reply' : 'replies'}
        </div>
      )}
    </div>
  );
}

/**
 * What a screen reader is told when a pin takes focus.
 *
 * The Peek itself is aria-hidden — it is decoration over a control that
 * already exists — so the same words go on the pin's accessible name instead,
 * where focus actually is.
 */
export function peekLabel(review, cluster = 0) {
  if (cluster > 1) return `${cluster} comments here`;
  if (!review) return 'Comment';
  const first = (review.messages || [])[0] || null;
  const body = String(first?.body || review.message || '').replace(/\s+/g, ' ').trim();
  const replies = Math.max(0, (review.messages?.length || 1) - 1);
  const bits = [
    `Comment ${review.number != null ? `#${review.number}` : ''}`.trim(),
    review.status,
    authorLabel(first || review.author, null),
    body.slice(0, 120),
    replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
  ].filter(Boolean);
  return bits.join('. ');
}
