import React from 'react';
import AutoTextarea from '../ui/AutoTextarea.jsx';
import ReviewThread from '../ui/ReviewThread.jsx';

// The markers on the canvas, and the box you type into.
//
// These are two different layers, and the difference matters:
//
//   A PIN belongs to the page. Its position is an element's rendered box, so it
//   has to scroll with the canvas and be clipped by it — a marker for something
//   below the fold must not float over the toolbar. It lives inside the frame's
//   overlay, beside the selection outlines.
//
//   A POPOVER belongs to the editor. It is a panel that happens to be pointing
//   at something. Drawn inside the frame it was clipped by it, and at the phone
//   breakpoint — a 375px frame — a 288px panel simply could not be read. So it
//   is drawn in the window instead, at the pin's window coordinates, and can
//   hang over the canvas edge like any other floating panel.
//
// Neither is ever inside the previewed document. A marker injected into the
// page would be in the DOM an agent reads back and in the picture `capture`
// takes, and Stacki would have started editing the website in order to describe
// it. Both take themselves off for a capture for the same reason.

// How much room a popover needs. Only used to decide which side of a pin to
// open on, so it is an estimate rather than a measurement — and a generous one,
// because opening inwards when there was room is invisible while opening
// outwards when there wasn't is a box you cannot read.
const BOX_W = 300;
const BOX_H = 320;
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

/**
 * Let the panel be pushed out of the way.
 *
 * A comment about an element opens on top of that element, which is exactly
 * where you cannot see it from — you want to read the note AND look at the
 * thing. So the header is a handle. The PIN never moves: it is the anchor, and
 * a marker that wandered would stop meaning anything. And the offset is
 * forgotten when the thread closes, because where somebody shoved a panel for
 * ten seconds is not a preference worth remembering.
 */
function useDragOffset(key) {
  const [offset, setOffset] = React.useState({ dx: 0, dy: 0 });
  React.useEffect(() => setOffset({ dx: 0, dy: 0 }), [key]);
  const start = (e) => {
    // Not from the buttons in the header — closing and deleting are clicks.
    if (e.target.closest('button')) return;
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY, ...offset };
    const move = (ev) => setOffset({ dx: from.dx + ev.clientX - from.x, dy: from.dy + ev.clientY - from.y });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return [offset, start];
}

/** Keep a dragged panel on screen — a note shoved off the edge is a note lost. */
function onScreen(x, y) {
  if (typeof window === 'undefined') return { x, y };
  return {
    x: Math.min(Math.max(x, -BOX_W + 80), window.innerWidth - 60),
    y: Math.min(Math.max(y, 8), window.innerHeight - 60),
  };
}

/**
 * The markers.
 *
 * `pins` is already laid out — PreviewPane does that once and hands the same
 * list to both layers, so a popover and its pin can never disagree about where
 * they are.
 */
export default function ReviewPins({ pins, visible, capturing, openId, onOpen }) {
  if (capturing || !visible) return null;
  return (
    <>
      {pins.map((pin) => {
        const isOpen = pin.reviews.includes(openId);
        const many = pin.reviews.length > 1;
        return (
          <button
            key={pin.key}
            className={`review-pin is-${pin.status} c-${pin.color || 'blue'}${isOpen ? ' open' : ''}${
              many ? ' many' : ''
            }`}
            style={{ left: pin.x, top: pin.y }}
            title={
              many
                ? `${pin.reviews.length} comments here — #${pin.numbers.join(', #')}`
                : `Comment #${pin.numbers[0]}`
            }
            onClick={(e) => {
              e.stopPropagation();
              // A cluster opens its first review; the panel is where the rest
              // of a busy element is read.
              onOpen(isOpen ? null : pin.reviews[0]);
            }}
          >
            {/* The number, so the pin on the page, the row in the panel and the
                thing an agent was told to fix are all called the same thing. */}
            {pin.numbers[0] ?? ''}
            {many && <span className="review-pin-more">+{pin.reviews.length - 1}</span>}
          </button>
        );
      })}
    </>
  );
}

/**
 * The composer and the opened thread, in the window rather than in the frame.
 *
 * `frameBox` is where the preview frame sits on screen, so a pin's canvas
 * coordinates can be turned into window ones. Without it nothing is drawn:
 * a panel at 0,0 in the corner of the app is worse than no panel.
 */
export function ReviewSurface({
  pins,
  frameBox,
  capturing,
  openId,
  onOpen,
  onAct,
  onFocus,
  onDelete,
  onColor,
  reviewById,
  busyId,
  draft,
  onDraftChange,
  onDraftSubmit,
  onDraftCancel,
}) {
  const openPin = openId ? pins.find((p) => p.reviews.includes(openId)) : null;
  const openReview = openId ? reviewById?.(openId) : null;
  // One hook, whichever panel is up, so the rules of hooks are kept while the
  // two branches below can still return early.
  const [offset, startDrag] = useDragOffset(draft ? 'draft' : openId);

  if (capturing || !frameBox) return null;

  const screen =
    typeof window === 'undefined'
      ? null
      : { width: window.innerWidth, height: window.innerHeight };
  const place = (x, y) => {
    const at = onScreen(x + offset.dx, y + offset.dy);
    return { left: at.x, top: at.y };
  };

  if (draft) {
    const at = toWindow(draft.x, draft.y, frameBox);
    return (
      <div
        className={`review-composer${sideClass(at.x, at.y, screen)}${offset.dx || offset.dy ? ' moved' : ''}`}
        style={place(at.x, at.y)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="review-composer-target review-drag" onPointerDown={startDrag}>
          <code>{draft.label}</code>
          {draft.breakpoint && draft.breakpoint !== 'desktop' && <span className="dim">{draft.breakpoint}</span>}
          {draft.occurrenceCount > 1 && Number.isInteger(draft.occurrence) && (
            <span className="dim">
              copy {draft.occurrence + 1}/{draft.occurrenceCount}
            </span>
          )}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onDraftSubmit();
          }}
        >
          <AutoTextarea
            value={draft.body}
            minRows={2}
            autoFocus
            placeholder="What’s wrong with this?"
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                onDraftSubmit();
              }
            }}
          />
          <div className="review-actions">
            <span className="review-hint">⌘↩ to post</span>
            <button type="button" className="ghost" onClick={onDraftCancel}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!draft.body.trim()}>
              Comment
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (!openPin || !openReview) return null;
  const at = toWindow(openPin.x, openPin.y, frameBox);
  return (
    <div
      className={`review-popover${sideClass(at.x, at.y, screen)}${offset.dx || offset.dy ? ' moved' : ''}`}
      style={place(at.x, at.y)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // The header is the handle; everything below it is a control.
        if (e.target.closest('.review-thread-head')) startDrag(e);
      }}
    >
      <ReviewThread
        review={openReview}
        busy={busyId === openReview.id}
        onAct={(action, extra) => onAct(openReview.id, action, extra)}
        onFocus={() => onFocus(openReview)}
        onDelete={() => onDelete(openReview.id)}
        onColor={(c) => onColor?.(openReview.id, c)}
        onClose={() => onOpen(null)}
      />
    </div>
  );
}
