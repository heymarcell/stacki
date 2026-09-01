---
name: stacki-audit-engine
description: The invariants of Stacki's audit - where it runs and why, what a finding may claim, source truthfulness, evidence, and the things it must never do. Load before changing anything under electron/mcp/audit/.
---

# Stacki audit engine

## Where it runs, and why that is a correctness decision

A hidden `BrowserWindow` of its own, pointed at the dev server Stacki is already
running, **without** the `#avb-design` hash. Not the canvas.

That is not politeness. The canvas iframe loads *with* the hash, and in that mode
the page keeps the `<template>` markers the editor addresses nodes through. A
`<template>` is an element and `:nth-child` counts it, so every nth-child rule
resolves differently there than it does for a visitor. Auditing the canvas is
auditing a document nobody will ever see.

Without the hash those markers remove themselves while `data-avb-p` and the comment
markers survive — the one configuration that is both true to the site and traceable
to source. `electron/thumbs.js` has rendered project pages this way for the same
reason since long before the audit existed.

Fresh window and size set **before** the load, one per viewport. Resizing a loaded
window re-evaluates media queries correctly but leaves a page whose script read
`innerWidth` once laid out for the first width and stretched to the rest.

## What a finding may claim

| kind | means |
| --- | --- |
| `mechanical` | Measured from geometry or computed style. True; not a rule anybody wrote down. |
| `standard` | A named engine rule with its WCAG criterion. A rule has been broken. |
| `advisory` | A heuristic. Not a violation of anything. |
| `incomplete` | The engine could not decide. Not a pass, not a failure. |

`incomplete` keeps its own bucket and its own count. **Folding it into "clean" is how
no-violations becomes accessible**, and that is the overclaim the whole design exists
to prevent.

Never ship: a design score, a quality percentage, a professionalism rating, a
compliance badge, or the sentence "WCAG compliant". Automated rules find roughly
half of what a real audit finds, and the payload says so itself.

## Overflow is not "is this element wide"

A carousel, a wide table and a code block are all wider than the viewport on
purpose. The test is whether the **document** scrolls sideways (`scrollWidth -
clientWidth >= 2`; the tolerance is real — `scrollWidth` is an integer and
sub-pixel layout leaves spurious 1px deltas), and then which elements stick out
with **nothing between them and the root** that would have contained them.

Skip an element whose own `overflow-x` clips or scrolls, and any element with such
an ancestor before the root. Carry the computed `overflow-x` that got an element
blamed, so the reasoning is inspectable.

## Source truthfulness

- A real `data-avb-p` model path, or `null`. Never a ref minted from a CSS selector,
  never a line number Stacki cannot prove.
- `exact: false` when the nearest marker was an **ancestor** — "somewhere inside this
  component" is a different claim from "this node".
- A finding with a selector, a rectangle and a screenshot and no source location is
  more useful than one with a confident lie in it.

## Stable ids

Hash the rule, the viewport and where the problem is — never its current
measurement. An overflow shrinking from 125px to 40px is the **same finding, still
there**; only a fix removes it. This is what lets `run → fix → run` prove a fix by an
id disappearing rather than infer it from a shorter array.

## Side-effect free

Running an audit must not:

- write any project file
- click, submit, focus or navigate anything (a control cannot be inspected by
  activating it)
- move the person's viewport, scroll, selection or open route
- leak a window, process, port or temp directory
- require the network

Every window is registered in `liveWindows` and destroyed in a `finally`, so cleanup
is **counted** rather than trusted — a hidden window that leaks is invisible by
construction.

## Evidence

A capture is taken after the measurement, in the same window, in the same state,
with nothing in between that could move the layout. Off by default; bounded in count
and in bytes through `capture.js`'s existing encoder.

**A picture that cannot change is not evidence.** The test that matters is the same
route at the same width either side of a change that alters what it looks like.

## Bounds

Findings are capped. When the cap bites, say so and report the **true** total.
Nothing is ever silently discarded.

## Fixing is not the audit's job

Remediation goes through the ordinary write operations — `style.set_property`,
`target.set_prop`, `target.set_classes`, source operations where a semantic one
cannot express the change. There is no "fix audit issue" API and there should not
be; the point is that Phase A's operations become useful, not that a new one appears.
The audit never applies its own fix, and fixing needs `edit` while finding needs
`inspect`.
