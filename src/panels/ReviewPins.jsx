import React from 'react';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import ReviewPeek, { peekLabel } from './ReviewPeek.jsx';
import ReviewCluster from './ReviewCluster.jsx';
import { applyMarkdownKey } from '../ui/markdownKeys.js';

// The markers on the canvas, and the one thing that is still typed over it.
//
// These are two different layers, and the difference matters:
//
//   A PIN belongs to the page. Its position is an element's rendered box, so it
//   has to scroll with the canvas and be clipped by it — a marker for something
//   below the fold must not float over the toolbar. It lives inside the frame's
//   overlay, beside the selection outlines.
//
//   Everything else here belongs to the editor and is drawn in the window, at
//   the pin's window coordinates, so a 375px phone frame cannot cut it in half.
//
// What used to be here and is gone: the conversation. Clicking a pin opened a
// draggable window containing the whole thread, its replies, its workflow
// buttons and its own scrollbar — on top of the design it was about. It could
// be moved, which meant it had to be moved, and reading a review meant covering
// the thing the review was about.
//
// A pin says WHERE. The conversation lives in the Review Inspector, which has
// room for it and does not sit on the website. So the three surfaces that
// remain over the canvas are all small, all transient, and only one of them
// takes any input:
//
//   Peek     read-only, on hover or focus. Says what a pin is.
//   Cluster  selection only. Says which review, when several share a spot.
//   Composer the new-comment box. The only content entry left over the canvas,
//            because writing a comment is inherently spatial — you are saying
//            "this thing here".
//
// Nothing here is draggable any more.

// How much room the composer needs, to decide which side of the point to open
// on. An estimate, and a generous one: opening inwards when there was room is
// invisible, opening outwards when there wasn't is a box you cannot read.
const BOX_W = 330;
const BOX_H = 260;
const GAP = 14;

/** Which way a box hanging off a point has to open to stay on screen. */
export function placement(x, y, bounds) {
  const w = Number(bounds?.width) || 0;
  const h = Number(bounds?.height) || 0;
  return {
    flipX: w > 0 && x + BOX_W + GAP > w,
    flipY: h > 0 && y + BOX_H + GAP > h,
  };
}

const sideClass = (x, y, bounds) => {
  const at = placement(x, y, bounds);
  return `${at.flipX ? ' flip-x' : ''}${at.flipY ? ' flip-y' : ''}`;
};

/** A pin's position in the window, given where the preview frame is. */
const toWindow = (x, y, frameBox) => ({
  x: (Number(frameBox?.left) || 0) + (Number(x) || 0),
  y: (Number(frameBox?.top) || 0) + (Number(y) || 0),
});

/** How much of a surface has to stay on screen to be usable. */
const KEEP = 60;

/**
 * Keep a surface reachable near the edges of the window.
 *
 * Flipping decides which side of the point it opens on; this catches what
 * flipping cannot — a point so close to an edge that even the flipped box
 * hangs off it. A composer whose Post button is off the screen is a comment
 * nobody can leave.
 */
export function clampToWindow(x, y, w = BOX_W) {
  if (typeof window === 'undefined') return { x, y };
  return {
    x: Math.min(Math.max(x, -(w - KEEP)), window.innerWidth - KEEP),
    y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - KEEP)),
  };
}

/**
 * Long enough that crossing a pin on the way somewhere else does not flash a
 * preview, short enough that pausing on one feels immediate.
 */
const PEEK_DELAY_MS = 280;

/**
 * The markers.
 *
 * `pins` is already laid out — PreviewPane does that once and hands the same
 * list to both layers, so a marker and anything pointing at it can never
 * disagree about where they are.
 */
export default function ReviewPins({ pins, visible, capturing, openId, onOpen, onPeek, reviewById }) {
  const timer = React.useRef(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  if (capturing || !visible) return null;

  const peekSoon = (pin) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onPeek?.(pin), PEEK_DELAY_MS);
  };
  const peekNow = (pin) => {
    clearTimeout(timer.current);
    onPeek?.(pin);
  };
  const peekOff = () => {
    clearTimeout(timer.current);
    onPeek?.(null);
  };

  return (
    <>
      {pins.map((pin) => {
        const isOpen = pin.reviews.includes(openId);
        const many = pin.reviews.length > 1;
        const only = many ? null : reviewById?.(pin.reviews[0]) || null;
        return (
          <button
            key={pin.key}
            className={`review-pin is-${pin.status} c-${pin.color || 'blue'}${isOpen ? ' open' : ''}${
              many ? ' many' : ''
            }`}
            style={{ left: pin.x, top: pin.y }}
            aria-label={peekLabel(only, pin.reviews.length)}
            aria-current={isOpen ? 'true' : undefined}
            onPointerEnter={() => peekSoon(pin)}
            onPointerLeave={peekOff}
            // Keyboard focus gets the same context, immediately: somebody
            // tabbing to a pin has already decided to look at it.
            onFocus={() => peekNow(pin)}
            onBlur={peekOff}
            onClick={(e) => {
              e.stopPropagation();
              peekOff();
              // One rule, whatever is behind the marker: a single review opens
              // in the Inspector, a cluster asks which one first. It never
              // picks for you.
              onOpen(pin);
            }}
          >
            {/* The number, so the pin on the page, the row in the panel and the
                thing an agent was told to fix are all called the same thing.
                In its own element because it gets nudged onto the pin's
                optical centre, which is not the centre of its box. */}
            <span className="review-pin-n">{many ? pin.reviews.length : pin.numbers[0] ?? ''}</span>
          </button>
        );
      })}
    </>
  );
}

/**
 * The three transient surfaces, in the window rather than in the frame.
 *
 * `frameBox` is where the preview frame sits on screen, so a pin's canvas
 * coordinates can be turned into window ones. Without it nothing is drawn: a
 * panel at 0,0 in the corner of the app is worse than no panel.
 */
export function ReviewSurface({
  pins,
  frameBox,
  capturing,
  peek,
  cluster,
  onPickFromCluster,
  onCloseCluster,
  reviewById,
  draft,
  onDraftChange,
  onDraftSubmit,
  onDraftCancel,
}) {
  if (capturing || !frameBox) return null;

  const screen =
    typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight };

  // --- the new-comment composer --------------------------------------------
  //
  // The only surface here that takes input, and the only one that should:
  // writing a comment IS spatial. The draft anchor beside it shows exactly
  // which point is being commented on, so what you get is never a surprise.
  if (draft) {
    const point = toWindow(draft.x, draft.y, frameBox);
    // The anchor stays on the point; only the box is pulled back on screen, so
    // the marker never lies about which element is being commented on.
    const at = clampToWindow(point.x, point.y);
    return (
      <>
        <span className="review-draft-anchor" style={{ left: point.x, top: point.y }} aria-hidden="true" />
        <div
          className={`review-composer${sideClass(at.x, at.y, screen)}`}
          style={{ left: at.x, top: at.y }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="New comment"
        >
          <div className="review-composer-head">
            <strong>New comment</strong>
            <span className="review-composer-target">
              <code>{draft.label}</code>
              {draft.breakpoint && draft.breakpoint !== 'desktop' && <span className="dim">{draft.breakpoint}</span>}
              {draft.occurrenceCount > 1 && Number.isInteger(draft.occurrence) && (
                <span className="dim">
                  copy {draft.occurrence + 1}/{draft.occurrenceCount}
                </span>
              )}
            </span>
            <button type="button" className="review-x" onClick={onDraftCancel} title="Cancel" aria-label="Cancel">
              ✕
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onDraftSubmit();
            }}
          >
            <AutoTextarea
              value={draft.body}
              minRows={3}
              maxRows={10}
              autoFocus
              placeholder="Leave a comment…"
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  onDraftSubmit();
                  return;
                }
                // The same four shortcuts the reply box has. A composer where
                // ⌘B did nothing, next to one where it worked, would be the
                // kind of inconsistency people stop trusting.
                const field = e.currentTarget;
                const next = applyMarkdownKey(
                  { value: field.value, selectionStart: field.selectionStart, selectionEnd: field.selectionEnd },
                  e
                );
                if (!next) return;
                e.preventDefault();
                onDraftChange(next.value);
                requestAnimationFrame(() => {
                  try {
                    field.setSelectionRange(next.selectionStart, next.selectionEnd);
                    field.focus();
                  } catch {
                    /* the field went away while the frame was pending */
                  }
                });
              }}
            />
            <div className="review-actions">
              <span className="review-md-hint">Markdown supported</span>
              <button type="button" className="ghost" onClick={onDraftCancel}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!draft.body.trim()}>
                Post
              </button>
            </div>
          </form>
        </div>
      </>
    );
  }

  // --- the cluster chooser --------------------------------------------------
  if (cluster) {
    const at = toWindow(cluster.x, cluster.y, frameBox);
    return (
      <ReviewCluster
        at={at}
        reviews={cluster.reviews.map((id) => reviewById?.(id)).filter(Boolean)}
        onPick={onPickFromCluster}
        onClose={onCloseCluster}
      />
    );
  }

  // --- the passive peek -----------------------------------------------------
  if (peek) {
    const at = toWindow(peek.x, peek.y, frameBox);
    return (
      <ReviewPeek
        at={at}
        cluster={peek.reviews.length}
        review={peek.reviews.length > 1 ? null : reviewById?.(peek.reviews[0]) || null}
      />
    );
  }

  return null;
}
