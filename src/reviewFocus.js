// Going back to what somebody was looking at.
//
// Focus is the operation the whole feature stands on. A comment an agent
// cannot navigate to is a sentence in a list; a comment it CAN navigate to is
// a piece of work with a picture attached. So this has to put the app back the
// way it was — the page, the breakpoint, the components drilled into, the node,
// and which copy of a repeated node — and where it cannot, say so instead of
// selecting something near enough.
//
// The plan is worked out here, as data, and carried out by App with the
// navigation it already has: selectPage, openComponent, setSelectedId. Nothing
// in this file touches React, and nothing in App invents a second way to move
// around — a review focus is the same three calls a person makes with the mouse.
//
// The order is not arbitrary. Page first, because a component drill is
// expressed as an index path INTO the page. Breakpoint before the node,
// because a review written at 375px is often about something that only
// happens at 375px, and selecting first would measure the wrong box. The node
// last, because the file it lives in isn't open until the drills are done.

import { anchorSteps, componentNameOf } from './reviewAnchor.js';

// The breakpoints a review can be put back into. `custom` is a width somebody
// dragged to, which is not a breakpoint and not reproducible; `canvas` shows
// every breakpoint at once and is a real choice, so it is restorable.
const RESTORABLE = ['desktop', 'tablet', 'phone', 'canvas'];

/**
 * What has to happen to look at this review.
 *
 * `pageFile` and `device` are where the app is now, so the plan can say which
 * parts are already true — reopening the page you are on would reload the
 * preview and throw away the canvas for nothing.
 */
export function focusPlan(anchor, { pageFile = null, device = null, drilledIn = false, previewReady = true } = {}) {
  const steps = anchorSteps(anchor);
  const wantPage = anchor?.page?.file || (steps[0] ? steps[0].file : null);
  const wantDevice = anchor?.breakpoint?.device || null;

  return {
    page: {
      file: wantPage,
      route: anchor?.page?.route || null,
      // Opening the page is also how you get OUT of a component. A drill is an
      // index path into the page, so a focus that started while somebody was
      // already two components deep had nothing to walk from — it waited for
      // the page to become the open file, which nothing was going to do, and
      // reported the review orphaned. Being on the right page is not enough;
      // being at the page is.
      needed: !!wantPage && (wantPage !== pageFile || drilledIn),
    },
    device: {
      key: wantDevice,
      restorable: RESTORABLE.includes(wantDevice),
      needed: !!wantDevice && RESTORABLE.includes(wantDevice) && wantDevice !== device,
    },
    // Each door into a component: where the instance sits in the file above it,
    // and which component it is expected to open.
    drills: steps.slice(0, -1).map((s, i) => ({
      hostFile: s.file,
      // Level 0 is the page, whose paths carry no file namespace — App's own
      // pathFor works the same way.
      hostIsPage: i === 0,
      indexPath: s.indexPath,
      opens: s.opens,
      componentFile: steps[i + 1] ? steps[i + 1].file : null,
    })),
    leaf: steps.length ? { file: steps[steps.length - 1].file, indexPath: steps[steps.length - 1].indexPath } : null,
    // Which rendered copy. Null means the node rather than one copy of it,
    // which is what every route to a selection except a canvas click means.
    occurrence: Number.isInteger(anchor?.occurrence) ? anchor.occurrence : null,
    // Whether the canvas is actually showing anything. A focus can identify the
    // right source node with no preview at all — and then there is nothing to
    // scroll to, nothing to measure and nothing to photograph, which is not the
    // same as a successful restore.
    previewReady: !!previewReady,
  };
}

/**
 * The marker path App knows a node by, at one level of the drill.
 *
 * The page's own nodes are bare index paths; anything inside an open component
 * is namespaced with that component's file. Same rule as App's `pathFor`,
 * spelled here because focus builds these before the app has caught up with
 * where it is being sent.
 */
export function hostPathFor(file, trail, isPage) {
  const path = (trail || []).join('.');
  return isPage ? path : `${file}|${path}`;
}

/** Everything a focus could restore, all false. */
export const nothingRestored = () => ({
  page: false,
  breakpoint: false,
  component: false,
  node: false,
  occurrence: false,
});

/**
 * What to tell whoever asked, in a sentence.
 *
 * Degrading honestly is the point: "the page is open but the element is gone"
 * is useful, and an agent that reads it will go and read the review's creation
 * context instead of photographing whatever happened to be selected. Silence,
 * or a cheerful `ok: true`, is how a screenshot of the wrong element ends up
 * in a pull request.
 */
const why = {
  changed: 'what is in that position now is a different kind of node',
  gone: 'nothing in the file matches it any more',
  ambiguous: 'several nodes match it equally well, and picking one would be a guess',
  no_path: 'the review has no usable position recorded',
  not_open: 'the file it lives in did not open in time — the preview may still be starting',
  moved_away:
    'it was selected, and then Stacki navigated somewhere else — the project may still have been opening. Try again',
};

export function focusNote({ restored, anchorState, plan, reason } = {}) {
  const r = restored || nothingRestored();
  if (anchorState === 'attached') {
    const notes = [];
    if (plan?.device?.key && !plan.device.restorable) {
      notes.push(
        `This review was written at a dragged canvas width, which is not a breakpoint Stacki can restore — it was left at the current one.`
      );
    }
    // The preview being down explains everything below it, and explains it
    // differently: nothing is missing from the source, the canvas simply is
    // not rendering. Saying "that copy is gone" here would send an agent
    // looking for a bug that isn't there — and capture would photograph
    // nothing.
    if (plan && plan.previewReady === false) {
      notes.push(
        'The element was found in source, but the Stacki preview is not rendering yet — nothing was scrolled to and a capture will not show it. Wait for the preview and focus again.'
      );
    } else if (plan?.occurrence != null && !r.occurrence) {
      notes.push(
        `Copy ${plan.occurrence + 1} of the repeated node is not on the page any more; the node itself is selected.`
      );
    }
    return notes.length ? notes.join(' ') : null;
  }

  if (!r.page) {
    return `The page this review was left on (${plan?.page?.file || 'unknown'}) is not in this project any more, so there is nothing to show. The review still says what it was about.`;
  }
  if (!r.component) {
    return `The page is open, but the way down to this review — through ${
      (plan?.drills || []).map((d) => `<${d.opens}>`).join(' › ') || 'its component'
    } — could not be walked: ${why[reason] || 'it no longer resolves'}. Read the review's creationContext for what it was about.`;
  }
  return `The page is open, but this review's element could not be identified — ${
    why[reason] || 'it no longer resolves'
  }. It is orphaned; nothing was selected. Read the review's creationContext for what it was about.`;
}

export default focusPlan;
