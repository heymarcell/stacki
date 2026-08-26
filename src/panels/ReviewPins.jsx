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

// The panel's actual width, from .review-popover in styles.css. Used only as
// the fallback for a clamp before the box has been measured — the measurement
// is what normally decides, and this is a real number rather than the generous
// estimate the flip test uses.
const PANEL_W = 348;
// How much of the panel has to stay on screen for it to be grabbable again.
const KEEP = 60;
// The same idea while a drag is in flight, with a little more margin so the
// header — and therefore the close button — is never the part that goes.
const DRAG_KEEP = 72;

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
 * The panel's real size, watched.
 *
 * A thread's height depends on what is in it, so a constant cannot clamp it.
 * ResizeObserver is not available in every environment this renders in — jsdom
 * has none — so the measurement is optional and the fallback is the stylesheet
 * width with no vertical clamp, which is the behaviour that cannot push a
 * panel somewhere unreachable.
 */
function useMeasuredSize(nodeRef, deps) {
  const [size, setSize] = React.useState(null);
  React.useEffect(() => {
    const node = nodeRef.current;
    if (!node) return undefined;
    const read = () => {
      const r = node.getBoundingClientRect();
      if (r.width && r.height) setSize({ w: r.width, h: r.height });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return size;
}

/**
 * Keep a panel reachable, wherever it is being put.
 *
 * Applies to the anchored position as much as to a dragged one: a pin near the
 * right edge of a narrow window would otherwise open a panel whose header —
 * and therefore its close button — is off the screen.
 */
export function clampPoint(x, y, size) {
  if (typeof window === 'undefined') return { x, y };
  const w = size?.w || PANEL_W;
  return {
    x: Math.min(Math.max(x, -(w - KEEP)), window.innerWidth - KEEP),
    y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - KEEP)),
  };
}

/**
 * Let the panel be pushed out of the way.
 *
 * A comment about an element opens on top of that element, which is exactly
 * where you cannot see it from — you want to read the note AND look at the
 * thing. So the header is a handle. The PIN never moves: it is the anchor, and
 * a marker that wandered would stop meaning anything. And the offset is
 * forgotten when the thread closes, because where somebody shoved a panel for
 * ten seconds is not a preference worth remembering.
 *
 * The previous version put the offset in React state and set it on every
 * pointermove, so a whole ReviewThread — every message, every Markdown body —
 * re-rendered per pixel of movement. Worse, the anchored flip placement kept
 * being recomputed from the moving position, so crossing the boundary where
 * the box would have opened on the other side made it jump the width of
 * itself.
 *
 * So: the pointer is captured, one pointer owns the drag, the geometry is
 * frozen at pointerdown, the flip decision is frozen with it, movement writes
 * a CSS variable inside a rAF, and React hears about it exactly once at the
 * end.
 */
function useDragOffset(key) {
  // The committed position. React only ever sees this — never the intermediate
  // frames — which is what stops a thread re-rendering per pixel.
  const [offset, setOffset] = React.useState({ dx: 0, dy: 0 });
  const [dragging, setDragging] = React.useState(false);
  const nodeRef = React.useRef(null);
  const live = React.useRef({ dx: 0, dy: 0 });

  React.useEffect(() => {
    setOffset({ dx: 0, dy: 0 });
    live.current = { dx: 0, dy: 0 };
    const node = nodeRef.current;
    if (node) {
      node.style.setProperty('--drag-x', '0px');
      node.style.setProperty('--drag-y', '0px');
    }
  }, [key]);

  const start = (e) => {
    // Not from a control, and not from anything selectable. Pulling on a
    // header is a drag; pulling across a sentence is a selection, and the two
    // must never be the same gesture.
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, textarea, [data-no-drag]')) return;
    const node = nodeRef.current;
    if (!node) return;

    // Frozen once, here. Everything below is arithmetic on numbers that cannot
    // change while the pointer is down — no measuring a moving box, and no
    // asking again which side of the pin to open on.
    const rect = node.getBoundingClientRect();
    const from = { x: e.clientX, y: e.clientY, dx: live.current.dx, dy: live.current.dy };
    const size = { w: rect.width, h: rect.height };
    const origin = { left: rect.left - live.current.dx, top: rect.top - live.current.dy };
    const pointerId = e.pointerId;

    e.preventDefault();
    try {
      node.setPointerCapture(pointerId);
    } catch {
      /* a pointer that cannot be captured still drags; it just is not exclusive */
    }
    setDragging(true);

    // `queued` rather than the rAF handle, because the handle is assigned
    // AFTER the callback in any environment where rAF runs synchronously — so
    // paint would clear a variable that is then immediately set again, and the
    // second frame would never be scheduled. A flag set before scheduling
    // cannot get out of order with itself.
    let queued = false;
    let handle = 0;
    let pending = null;
    const paint = () => {
      queued = false;
      handle = 0;
      if (!pending) return;
      node.style.setProperty('--drag-x', `${pending.dx}px`);
      node.style.setProperty('--drag-y', `${pending.dy}px`);
      live.current = pending;
    };

    const move = (ev) => {
      // One pointer owns this. A second finger or a stray device must not
      // steer a drag it did not begin.
      if (ev.pointerId !== pointerId) return;
      const wanted = {
        dx: from.dx + ev.clientX - from.x,
        dy: from.dy + ev.clientY - from.y,
      };
      // Clamped against the panel's MEASURED size, so a tall thread cannot be
      // pushed below the window and a wide one cannot be lost off the side.
      // The old clamp used two constants that had nothing to do with the box
      // actually on screen.
      pending = clampToWindow(wanted, origin, size);
      if (!queued) {
        queued = true;
        handle = requestAnimationFrame(paint);
      }
    };

    const finish = (ev) => {
      if (ev && ev.pointerId !== pointerId) return;
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', finish);
      node.removeEventListener('pointercancel', finish);
      if (queued) {
        if (handle) cancelAnimationFrame(handle);
        paint();
      }
      try {
        node.releasePointerCapture(pointerId);
      } catch {
        /* already released, or never captured */
      }
      setDragging(false);
      // The one commit. Where the variable already put it, so nothing moves
      // at pointer-up.
      setOffset({ ...live.current });
    };

    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
  };

  return { offset, start, dragging, nodeRef };
}

/**
 * Keep a dragged panel reachable.
 *
 * Measured, not guessed: enough of the panel stays on screen that it can
 * always be grabbed again, and its header can never be pushed above the top of
 * the window where there is nothing to take hold of.
 */
export function clampToWindow(wanted, origin, size) {
  if (typeof window === 'undefined') return wanted;
  // Nothing to clamp against. A box that has not been laid out measures zero,
  // and a zero width turns the "keep this much on screen" bound into a
  // POSITIVE minimum offset — which pinned the panel 72px from where the
  // pointer was and then held it there for the whole drag.
  if (!size || !size.w || !size.h) return wanted;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = origin.left + wanted.dx;
  const top = origin.top + wanted.dy;
  const minLeft = -(size.w - DRAG_KEEP);
  const maxLeft = vw - DRAG_KEEP;
  // The header must stay reachable, so the top edge never goes above 0.
  const minTop = 0;
  const maxTop = vh - Math.min(size.h, DRAG_KEEP);
  return {
    dx: wanted.dx + (Math.min(Math.max(left, minLeft), maxLeft) - left),
    dy: wanted.dy + (Math.min(Math.max(top, minTop), maxTop) - top),
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
                thing an agent was told to fix are all called the same thing.
                In its own element because it gets nudged onto the pin's
                optical centre, which is not the centre of its box. */}
            <span className="review-pin-n">{pin.numbers[0] ?? ''}</span>
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
  onEditMessage,
  onDeleteMessage,
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
  const { offset, start: startDrag, dragging, nodeRef } = useDragOffset(draft ? 'draft' : openId);
  // Measured whenever the thread being shown changes, because a one-line
  // review and a forty-message one are different shapes.
  const measured = useMeasuredSize(nodeRef, [draft ? 'draft' : openId, openId]);

  if (capturing || !frameBox) return null;

  const screen =
    typeof window === 'undefined'
      ? null
      : { width: window.innerWidth, height: window.innerHeight };
  // The anchor point only. The drag offset rides in CSS variables, so moving
  // the panel does not change any React-owned position — which is what lets a
  // drag avoid re-rendering the thread.
  const place = (x, y) => {
    const at = clampPoint(x, y, measured);
    return {
      left: at.x,
      top: at.y,
      // The drag offset rides in CSS variables, so moving the panel changes no
      // React-owned position — which is what lets a drag avoid re-rendering
      // the whole thread.
      '--drag-x': `${offset.dx}px`,
      '--drag-y': `${offset.dy}px`,
    };
  };
  const moved = offset.dx || offset.dy ? ' moved' : '';
  const dragCls = dragging ? ' is-dragging' : '';

  if (draft) {
    const at = toWindow(draft.x, draft.y, frameBox);
    return (
      <div
        ref={nodeRef}
        className={`review-composer${sideClass(at.x, at.y, screen)}${moved}${dragCls}`}
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
      ref={nodeRef}
      className={`review-popover${sideClass(at.x, at.y, screen)}${moved}${dragCls}`}
      style={place(at.x, at.y)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        // The header is the handle; everything below it is words to read.
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
        onEditMessage={onEditMessage ? (messageId, message) => onEditMessage(openReview.id, messageId, message) : null}
        onDeleteMessage={onDeleteMessage ? (messageId) => onDeleteMessage(openReview.id, messageId) : null}
        onClose={() => onOpen(null)}
      />
    </div>
  );
}
