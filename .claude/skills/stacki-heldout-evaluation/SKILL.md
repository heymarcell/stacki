---
name: stacki-heldout-evaluation
description: How to run an evaluation whose result means something - pre-registration, a corpus nobody wrote for the product, the dev/held-out split, and the oracle mistakes that look like product defects. Load before designing or reading a Stacki behavioural evaluation.
---

# Held-out evaluation

## Pre-register, then measure

The corpus, the tasks, the oracles, the split and the metrics go into
`scripts/eval/heldout/manifest.json` **and get committed before any product
change**, so the git history shows the tasks were not chosen to suit the result.

After that point the held-out set is frozen. Investigate on the dev set.

**When a held-out task turns out to be objectively invalid, record the defect and
the replacement in `manifest.json` with the reason it is not tuning.** A
pre-registered corpus whose failures get quietly edited away is not
pre-registered. The bar for a replacement is that it is *stronger*, not that it
passes.

## A corpus nobody wrote for the product

The Phase-B fixture has a `Hero`, a `Card` and a `--brand` because its tasks
needed them, and `task.fixture` can only ADD files to it. No overlay makes it
unfamiliar. Every number measured against it is measured against a project
designed to be easy for the thing under test.

Use projects from outside: upstream's own examples, pinned to one commit,
content-hashed, materialised read-only, and worked on only in disposable copies.
Never clone, fork, push to or open anything against the upstream repository.

**Hash only what upstream shipped.** `npm install` writes `package-lock.json`,
Astro writes `.astro` and `dist`, the packaged app writes `.stacki-automation`,
macOS writes `.DS_Store`. A hash that counts them verifies once and then fails
forever, which is the same as not verifying.

## The oracle is the thing most likely to be wrong

Both failures in the first held-out baseline were the oracle, and both looked
exactly like product defects.

- **It raced the dev server.** The check fetched the page the instant the agent
  finished and read a stale title out of a file that was already correct. Astro
  needs ~300ms to invalidate a changed module. Poll to a bounded deadline and
  report the last answer either way — that is not more forgiving, because an edit
  that never lands still fails.
- **It was keyed to the wrong project.** "Nothing changed" was checked by looking
  for one project's heading inside another's file. Hash the whole tree instead:
  it is the stronger claim, and it catches a write that lands somewhere the brief
  never named.

Before believing a failure is the product, reproduce it **without** the product.

## Every check reads the world

The file on disk, the page the dev server serves, the audit's own findings, the
process table. Never the agent's account of itself: an agent that says it made a
change and did not, fails. Where the answer is prose, take it through the host's
structured-output schema so the check is exact rather than a regex over English.

An oracle must also catch the *wrong* success: a token changed and every
neighbouring token changed too, a defect "fixed" by deleting the control beside
it, a refusal that held for the named file and let something else through.

## Do not build a benchmark that answers itself

The previous discovery task asked for exactly the four fields
`stacki://project/profile` emits, in the same order. The candidate won it by
construction. Ask instead for facts that are in the project and are not the shape
of any single response — which layout one named page uses, how many entries a
collection has.

Two rules keep it honest, and both are enforced rather than intended: no fixture
identifier may appear in anything Stacki ships, and the baseline is the strongest
honest one. A weak baseline hands the candidate a win it did not earn.

Check what the baseline arm actually IS. `launch.sh` pinned it to `origin/main`,
and once the candidate merged, `origin/main` *was* the candidate: a green A/A
test reporting a truthful ~0 delta. Print both shas in the result.

## Report per class, never one number

A discovery task and a one-word edit want opposite things. A single "calls"
figure over both says nothing and can be improved by making either one worse.

- **Semantic success first.** Efficiency is only interesting among trials that
  did the job.
- **A verification call is not waste.** Removing real verification to shrink a
  number is gaming.
- **A targeted extra call that prevents a wrong edit is a win.**
- Print every trial, including the ones the candidate lost. A trial with no
  result file is a failure, not a row to drop.

## No change, with proof, is a result

If the friction a phase set out to fix does not reproduce on a real host, say so
with the numbers and change nothing. Measured here: guidance suspected of causing
ritual project-wide fetches produced **zero** profile reads on every purely
targeted task, and exactly one on each task where it helped. Shipping a fix for
that would have been a change with no evidence behind it.
