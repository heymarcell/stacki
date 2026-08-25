// Where the pins go.
//
// A pin is editor chrome drawn over the canvas, in the same overlay layer as
// the selection outlines — never inside the previewed page. That matters twice
// over: a marker injected into the site would end up in the DOM an agent is
// reading, and it would end up in the screenshot an agent is looking at.
//
// Its position comes from the element's rendered box and the ratios the click
// stored, so it moves when the layout does. An element that grows keeps its
// comment on the paragraph it was left on rather than 200 pixels above it, and
// a node that renders nothing this time round has no box, so it has no pin —
// which is the honest thing rather than a marker floating at 0,0.
//
// Several reviews on one element are one pin with a number on it. Two people
// (or a person and an agent) leaving notes on the same heading should not stack
// two markers on top of each other; two notes left deliberately at opposite
// ends of a long section should not be merged into one. So pins that land near
// each other join and pins that don't, don't.

// How close two pins have to be to be the same pin, in canvas pixels. About
// the width of the marker itself: closer than this and they would overlap.
const MERGE_PX = 26;

/**
 * The point a review's marker sits at, in the preview frame's coordinates.
 *
 * `rect` is one of the boxes the page reported for the node — `rects[path][occ]`
 * — so the copy matters: a review on the second card is placed on the second
 * card. Null when the node put nothing on the page.
 */
export function pinPoint(rect, pin) {
  if (!rect) return null;
  const w = Number(rect.w ?? rect.width) || 0;
  const h = Number(rect.h ?? rect.height) || 0;
  const x = Number(rect.x) || 0;
  const y = Number(rect.y) || 0;
  const xr = Number(pin?.xRatio);
  const yr = Number(pin?.yRatio);
  return {
    x: x + w * (Number.isFinite(xr) ? Math.min(1, Math.max(0, xr)) : 0.5),
    y: y + h * (Number.isFinite(yr) ? Math.min(1, Math.max(0, yr)) : 0.5),
  };
}

/**
 * Which copy of a repeated node a review's pin belongs on.
 *
 * A review made from a canvas click knows its copy. One made any other way —
 * from the navigator, from an agent with the node selected — means the node,
 * which is every copy of it; the first is where the pin goes, because a marker
 * on all four cards would say the comment was about all four.
 */
export function rectForReview(boxes, occurrence) {
  const list = Array.isArray(boxes) ? boxes : [];
  if (!list.length) return null;
  if (!Number.isInteger(occurrence)) return list[0];
  return list[occurrence] || list[0];
}

/**
 * Lay out every pin for the page as it is rendered right now.
 *
 * `items` are `{ id, path, occurrence, pin, status, anchorState }` — one per
 * review that resolved to a node in the open file. `rects` is what the page
 * reported, keyed by marker path. Reviews whose node is not on the page, and
 * orphans, come back in `hidden` rather than being dropped silently: the panel
 * says how many of its reviews have nowhere to point.
 */
export function placePins(items, rects) {
  const placed = [];
  const hidden = [];
  for (const item of items || []) {
    if (!item || item.anchorState === 'orphaned' || !item.path) {
      hidden.push(item?.id);
      continue;
    }
    const rect = rectForReview(rects?.[item.path], item.occurrence);
    const point = pinPoint(rect, item.pin);
    if (!point) {
      hidden.push(item.id);
      continue;
    }
    placed.push({ ...item, x: point.x, y: point.y });
  }

  // Merge what overlaps, keeping document order so "the first pin" means the
  // one nearest the top of the page.
  const groups = [];
  for (const p of placed) {
    const near = groups.find(
      (g) => g.path === p.path && g.occurrence === p.occurrence && Math.hypot(g.x - p.x, g.y - p.y) <= MERGE_PX
    );
    if (near) {
      near.reviews.push(p.id);
      if (p.number != null) near.numbers.push(p.number);
      // An open review in the group is what the marker should look like: a
      // cluster that reads as "resolved" because the newest one was closed
      // hides the fact that something in it still wants doing.
      if (p.status === 'open') near.status = 'open';
      else if (p.status === 'deferred' && near.status !== 'open') near.status = 'deferred';
      continue;
    }
    groups.push({
      key: `${p.path}@${p.occurrence ?? 'n'}@${Math.round(p.x)},${Math.round(p.y)}`,
      path: p.path,
      occurrence: p.occurrence,
      x: p.x,
      y: p.y,
      status: p.status,
      // The person's own colour. A cluster wears the first one's — it is a
      // grouping, not a state, so there is nothing to reconcile.
      color: p.color || 'blue',
      reviews: [p.id],
      // The short numbers in the cluster, so a marker can wear the same name
      // the panel and an agent use for it.
      numbers: [p.number].filter((n) => n != null),
    });
  }
  return { pins: groups, hidden };
}

/**
 * Whether a review's marker is drawn at all.
 *
 * Resolved reviews keep their pin off the canvas. They are done, the page is
 * covered in them after a week of work, and the panel is where a finished
 * review is read. Open and deferred both still want something from somebody,
 * so both are marked — a deferred one differently, since it is deliberately
 * not being acted on.
 */
export const pinnable = (status) => status === 'open' || status === 'deferred';

export default placePins;
