---
name: stacki-engineering
description: Stacki's non-negotiable engineering standard - the Phase-A regression floor, behaviour-over-grep testing, git and process ownership discipline, and what counts as proof. Load before writing or reviewing any Stacki test, or before committing.
---

# Stacki engineering standard

## 1. The test standard

This repository once had thousands of green assertions while the UI was broken.
Everything below exists because of that.

- **Behaviour over source grep.** A test that asserts a function exists, or that a
  string appears in a file, proves the repository agrees with itself. It proves
  nothing about the product.
- **Real integration over hand-written mock.** Drive the real MCP client, the real
  dev server, the real Astro project, the real packaged app.
- **World state over success envelope.** `{ok: true}` is not evidence. After a write,
  read the independent reality back: the file on disk, the editor model, the browser
  DOM, the rendered pixels, git, the process table, the HTTP endpoint.
- **A screenshot is the state asserted immediately before it.** Never a cached or
  previous-state image.
- **Cleanup failure is test failure.** Not a warning, not a log line.
- **A critical test must die when its invariant is sabotaged.** If you cannot break
  the product and watch a named test fail, you have not proven the invariant — you
  have only observed a green run.

When you claim a capability, name the test and the world state it inspects.

## 2. The Phase-A floor

Phase A is closed and independently reviewed. These are facts to preserve, not work
to redo:

- MCP protocol 2026-07-28, proven with the official modern client
- 111 Agent operations across 8 domains: 110 FULL + 1 BOUNDARY (`git.publish`)
- 444/444 permission subjects covered
- 13 top-level MCP tools
- Real Astro content fixture; real dev lifecycle; correct component-extraction transaction
- Target mutation: MCP -> source -> model -> Astro -> pixels -> undo
- Style mutation: MCP -> authored CSS -> cascade/computed state -> pixels -> undo
- Identity-based lifecycle ownership; 5/5 clean packaged lifecycle
- Fail-closed external-side-effect containment

Do not redesign Visual Review, Secure Share, review provenance, review source
anchoring, review epoch v3, the permission architecture, `component_create`
transaction semantics, the packaged bootstrap fence, lifecycle ownership, or the
update/signing policy **without behavioural evidence that a change requires it**.

An imagined prettier architecture is not evidence.

## 3. Reuse, don't reimplement

Stacki already owns a real browser, a real Astro dev server, a computed-style
engine, a capture pipeline with overlay stripping and paint synchronisation, a
permission gate, a ref/staleness model, and an ownership oracle.

Before building a subsystem, find the one that exists. A second implementation of
something Stacki already does is a defect, not a feature — it will drift.

## 4. Git discipline

- Never `git add .` or `git add -A`. Stage exact intended paths.
- `git status`, `git diff` and `git diff --check` before every commit.
- No rebase, no force push, no broad stash, no rewriting pushed history.
- Never modify `.claude/settings.json` or `.claude/settings.local.json`.
- Commits are coherent units of work, not one giant dump and not one per detector.

## 5. Process and resource ownership

- No `killall`. No broad `pkill`. Never kill generic `node`, `electron` or `astro`.
- Every process, port, window, temp directory and file a run creates is **owned** by
  that run by identity, and only that exact identity is terminated.
- Feed any new owned resource into the existing identity-based ownership system
  (`test/support/ownership.js`, `ownedResidue.js`, `ownedTemp.js`), never into a
  weaker parallel cleanup of its own.

## 6. No external side effects

- No automated test performs a real authenticated `gh repo create`/`delete`/`fork`
  or equivalent external mutation.
- `git.publish` stays the single fail-closed external BOUNDARY behind its test-owned
  fake `gh` (`test/support/fakeGh.js`).
- `heymarcell/stacki-wire-test-never-created` is forensic evidence. Never touch it.
- PRs go to `heymarcell/stacki` only. Never `flowtricks/stacki`.

## 7. Environment

Before every Node/npm command:

```
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
```

Do not use or repair Homebrew Node.

For Electron automation: `STACKI_NO_DIALOGS=1`, and `STACKI_HIDDEN_WINDOW=1` where
applicable. Automated work must never steal the user's focus or take over the
visible screen.

## 8. Scope

Deliver the requested scope in full. Ordinary engineering defects — a wrong test, a
race, a schema mismatch, a flaky suite, a packaging failure, a CI-only behaviour —
are work to diagnose and fix, not reasons to stop and ask. Stop only for a genuinely
external blocker that cannot be solved from the repository and environment.
