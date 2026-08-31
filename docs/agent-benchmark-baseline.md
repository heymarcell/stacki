# Agent benchmark — the Phase-A baseline

Recorded from the verified Phase-A closure (`main` 443b626) **before** any Phase-B
runtime change, with `scripts/bench-agent.js`. Re-record with:

    export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
    STACKI_NO_DIALOGS=1 BENCH_DEPS=1 node scripts/bench-agent.js

## What is measured, and why these three numbers

**PREAMBLE** — what every session pays before its first useful call.

**CLOSURE (calls-to-answer)** — for a fixed set of questions about the project in
front of you, the fewest calls at which each first becomes answerable from bytes
already received. This is the number that cannot be improved by writing a nicer
sentence: prose changes no answer's depth. Only a new resource, a richer response
or a better default does.

**DISCOVERY** — calls, invalid calls, redundant calls, stale-ref retries and
context bytes spent walking the read surface.

CONTEXT BYTES (the `content[].text` blocks) is the primary byte metric, because
that is the copy a model actually reads. `structuredContent` bytes are reported
beside it, never instead of it.

### The questions demand project-specific evidence

An earlier version of this set asked whether the word "components" had been seen,
and every question scored zero — the 131 KB `tools/list` mentions all of them. It
was measuring vocabulary, not knowledge. Each question now requires a name that
exists in the fixture and cannot appear in a tool schema or in static guidance.
Those fixture identifiers live in the measuring apparatus only; a lexical-firewall
test fails the build if any of them appears in anything Stacki ships.

### The baseline is the strongest honest one

Two probes take an argument derived from an earlier answer, because a capable
agent would derive it too: the collection name comes out of `content.collections`,
and `package.json` is the obvious place to look for a framework version. An
earlier run omitted both, which made two questions look unanswerable and would
have handed Phase B a win it had not earned.

## Baseline — Phase A, `agentMode: full`, dependencies installed

| Preamble | Value |
| --- | --- |
| server instructions | 1,527 bytes |
| tools/list | 13 tools, 131,761 bytes |
| resources/list | **0** — capability not advertised |
| prompts/list | **0** — capability not advertised |
| preamble total | 133,318 bytes |

| Question | calls to answer | bytes to answer |
| --- | --- | --- |
| what-pages | 4 | 149,025 |
| what-components | 4 | 149,025 |
| what-layouts | 4 | 149,025 |
| what-tokens | 6 | 152,139 |
| what-styles | 6 | 152,139 |
| what-collections | 9 | 153,811 |
| what-astro | 10 | 154,398 |
| what-classes | 11 | 154,508 |

| Summary | Value |
| --- | --- |
| answered | 8 / 8 |
| median calls to answer | 6 |
| **calls to answer the whole set** | **11** |
| **bytes to answer the whole set** | **154,508** |
| discovery calls | 11 |
| invalid calls | 0 |
| redundant calls | 0 |
| stale-ref retries | 0 |
| discovery context bytes | 21,220 |
| cleanup problems | none |

Without dependencies installed, `what-collections` is unanswerable at any depth —
the content-config service cannot read a config without a resolvable `astro:content`
— and the set closes at 7 / 8. Both arms of any comparison must therefore run in
the same condition; `BENCH_DEPS=1` is the condition of record.

## The candidate, measured the same way

Recorded after Phase B and Phase C, on the surface the product actually ships.

Two corrections were made to the apparatus before these numbers were taken, both
found by a fresh reviewer, and both had been flattering the candidate:

1. **The rig served thirteen tools.** `startWireRig` never passed an `audit`
   implementation, and `tools.js` registers that tool only when one is present —
   so the benchmark measured a server nobody has. The rig now takes an `audit`
   stub, and `tools/list` is the real 138,563 bytes.
2. **The seed omitted the two new lists.** It counted instructions and
   `tools/list` only, so the candidate was charged nothing for the
   `resources/list` and `prompts/list` it had added, even though `preamble()`
   had already measured them.

| Preamble | Phase A | Phase B+C (shipped) |
| --- | --- | --- |
| server instructions | 1,527 | 1,740 |
| tools/list | 131,761 (13) | 138,563 (14) |
| resources/list | 0 | 2,175 (6) |
| prompts/list | 0 | 1,077 (3) |
| **total** | **133,318** | **143,555** |

| Answering the whole eight-question set | Phase A | Phase B+C |
| --- | --- | --- |
| **calls** | **11** | **1** |
| median calls | 6 | 1 |
| **bytes** | **154,508** | **146,498** |
| invalid calls | 0 | 0 |
| redundant calls | 0 | 0 |
| stale-ref retries | 0 | 0 |

So: **ten fewer round trips, and about 8,000 fewer bytes** — a 91% cut in calls
and a 5.2% cut in bytes. The byte saving is much smaller than the call saving
because a session now pays 10,237 bytes more up front, 6,802 of which is the
`audit` tool's own schema and has nothing to do with Phase B. A session that
never asks a project question pays that and gets nothing back.

The guide resources — 10,480 bytes across five topics — are not in any of these
numbers, because nothing reads them unless it asks.

Running the candidate over the baseline's exact probe sequence (`BENCH_PROBE=legacy`)
reproduces Phase A's calls-to-answer question for question: 4, 4, 4, 6, 6, 8, 11,
10. No tool answer moved.

## What this says about Phase A

Nothing here is a defect. The surface is complete and correct: every question is
answerable, no call is invalid, none is redundant, and nothing leaks.

It is, however, expensive to *find* things. `tools/list` alone is 131 KB — 85% of
the preamble — and answering eight ordinary questions about the open project costs
eleven round trips on top of it. That is the cost Phase B has to move, without
making the preamble bigger and without removing any verification an agent should
still be doing.
