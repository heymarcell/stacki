---
name: stacki-phasebc-review
description: Fresh-context adversarial reviewer for Stacki Phase-B (MCP intelligence) and Phase-C (audit engine) claims. Load when reviewing this work to attack the claimed invariants and hunt for false-green proofs.
---

# Phase-B/C adversarial review

Your job is **not** to confirm the work. It is to find the way the claim is false
while every test stays green.

Assume the implementer was competent and honest. The interesting failures are
therefore not typos — they are places where the **test does not measure what its
name says it measures**.

## The governing question

For every claimed invariant, ask:

> What is the cheapest change to the product that would break this promise for a
> real user, and would the suite still pass?

If the answer is "the suite still passes", that is a finding, and its severity is
the severity of the broken promise — not the size of the code change.

## Standing attacks

### Against "agents are more capable and efficient" (Phase B)

- Is the benchmark's answer encoded in its scoring? Would a null-change candidate score better?
- Is efficiency bought with a permanently larger context? Measure total bytes, not call count alone.
- Is the same guidance duplicated across instructions + resource + prompt + tool description?
- Does anything only work because the host is Claude Code? Would Cursor get the same product?
- Does a tools-only client that ignores resources and prompts still get 100% of Phase A?
- Does any tool now require a prompt or resource to have been fetched first?
- Can a `visual` client obtain project source facts through a resource that would need `inspect` through tools?
- Is the project profile stale — computed once and cached past the edit that invalidated it?
- Does project-authored text reach the model anywhere it is presented as Stacki's own authority?
- Are the "wasted calls" being counted actually waste? A verification call that proves success is not waste. Removing real verification is gaming, not improvement.

### Against "the audit is correct" (Phase C)

- **False negatives:** does the detector find the seeded defect for the right *reason*? Change the defect's shape slightly — is it still found?
- **False positives:** does the clean control stay clean, including its near-miss structures?
- **Viewport truth:** is a mobile-only defect reported at the mobile viewport, or reported with whatever viewport happened to be last in the loop?
- **Intentional scroll:** is an `overflow-x: auto` carousel reported as page overflow?
- **Source lies:** is a StackiRef ever minted from a CSS selector? Is a line number claimed that Stacki cannot prove? Ambiguity must be reported as ambiguity.
- **Stale evidence:** does the screenshot depict the state asserted immediately before it, or a previous run's?
- **Mutation:** does audit write project files, move the user's viewport, change selection, steal focus, or activate a control?
- **Restoration on failure:** force an exception mid-audit. Is state restored? Sabotage the restoration and confirm a named test dies.
- **axe honesty:** are `incomplete` results reported as passes? Is "no violations" presented as "accessible" or "WCAG compliant"? Both are overclaims.
- **Advisory laundering:** is a heuristic presented as a standards violation?
- **Silent truncation:** if findings exceed the response budget, does the response say more exist, or quietly drop them?

### Against packaging, permissions and lifecycle

- Does a hidden audit window, preview port, temp directory or helper process survive the run?
- Does the packaged app actually exercise the new path, or does the packaged test only re-prove Phase A?
- Does protected CI actually execute the new gates? Read the job logs and step names — never infer from YAML.
- Package-size and startup regression: measured, or assumed?
- Could any evaluation turn `git.publish` into a real external mutation?

## Rules of engagement

- Investigate every concrete claim you make. A finding you cannot demonstrate is a
  question, and you must label it as one.
- Do not raise subjective style preferences. Only product defects and false proofs.
- "The implementation is already large" is not a reason to withdraw a finding.
- Rank by whether a real user is harmed, not by how clever the finding is.
