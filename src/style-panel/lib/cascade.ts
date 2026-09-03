// Cascade resolution → a rule-centric, editable model.
//
// We surface each matching rule as its own card (selector + its declaration
// list), because all the editing operations the panel offers — rename a
// property, change a value, add, remove, reorder — are scoped to a single rule.
// Cascade information is preserved as per-declaration status: among the matching
// BASE rules (no pseudo-class / pseudo-element / @media), each property has one
// winner (by !important, then specificity, then document order); losing
// declarations are flagged `overriddenBy` so you still see what actually applies.

import { canonicalCompound, compareSpecificity, matchSelectorList, type MatchTarget } from './selectors'
import type { ParsedRule, SelectorInfo, Specificity } from './types'

export type RuleKind = 'base' | 'pseudo-class' | 'pseudo-element' | 'at-rule'

// The interaction states the panel views (mirrors resolved.ts). A selector is
// "base" (applies in the resting view) unless its SUBJECT carries one of these or
// a pseudo-element. Structural pseudos (`:first-child`, `:nth-child`, `:not`) and
// pseudos on an ANCESTOR (`.u-section:first-child .u-heading`) keep it base — the
// subject is still styled at rest — so they must NOT push it into the pseudo bucket.
const VIEW_STATES = new Set([':hover', ':focus', ':active'])
function subjectHasState(text: string): boolean {
  return canonicalCompound(text).pseudoClasses.some((pseudo) => VIEW_STATES.has(pseudo))
}

export type DeclStatus = {
  /**
   * Whether this declaration is the one that applies AT REST. False only when
   * another base declaration for the same property beat it.
   *
   * Read it with `resolved`. For a conditional declaration (@media, :hover)
   * this is true because nothing at rest overrides it — which is not the same
   * statement as "this is the value the element has", and a caller that cannot
   * tell the two apart will report two winners for one property.
   */
  winning: boolean
  /** Selector of the declaration that overrides this one, when not winning. */
  overriddenBy: string | null
  /** Where that overriding declaration was authored. Three rules in three
   *  stylesheets can share a selector, so the text alone cannot name it. */
  overriddenByOrigin: { selector: string; source: string; sourceLabel: string } | null
  /**
   * Whether `winning` is the result of a cascade at all.
   *
   * False for a conditional rule: it applies only inside its @media query or
   * its interaction state, and resolving it would need a viewport and a pointer
   * this module is not given. The panel shows those as "what applies in that
   * state" and needs no more; anything asserting a winner has to stop here.
   */
  resolved: boolean
}

export type MatchedRule = {
  rule: ParsedRule
  /** The selectors (within the rule's list) that matched the element. */
  matchedSelectors: SelectorInfo[]
  kind: RuleKind
  conditional: boolean
  /** Display label: strongest matched selector, prefixed with any at-context. */
  label: string
  /** Per-declaration cascade status, keyed by declId. */
  declStatus: Record<string, DeclStatus>
}

export type RuleModel = {
  base: MatchedRule[]
  conditional: MatchedRule[]
  matchedRuleCount: number
}

type Hit = {
  rule: ParsedRule
  matchedSelectors: SelectorInfo[]
  strongestBase: { selector: SelectorInfo; specificity: Specificity } | null
  conditional: boolean
  kind: RuleKind
  label: string
}

/**
 * Cascade tie-break for one property, winner-first: `!important`, then
 * specificity, then document order (later wins). Shared by computeRuleModel and
 * the resolved-style model (lib/resolved.ts) so both agree on who wins.
 */
export function compareCascade(
  a: { important: boolean; specificity: Specificity },
  b: { important: boolean; specificity: Specificity },
  aOrder: number,
  bOrder: number,
): number {
  if (a.important !== b.important) return a.important ? -1 : 1
  const spec = compareSpecificity(b.specificity, a.specificity)
  if (spec !== 0) return spec
  return bOrder - aOrder // later wins on a tie
}

function strongestOf(selectors: SelectorInfo[]): { selector: SelectorInfo; specificity: Specificity } | null {
  let best: { selector: SelectorInfo; specificity: Specificity } | null = null
  for (const selector of selectors) {
    if (!best || compareSpecificity(selector.specificity, best.specificity) > 0) {
      best = { selector, specificity: selector.specificity }
    }
  }
  return best
}

export async function computeRuleModel(rules: ParsedRule[], target: MatchTarget): Promise<RuleModel> {
  const hits: Hit[] = []

  for (const rule of rules) {
    const results = await matchSelectorList(rule.selectorText, target)
    const matchedSelectors = rule.selectors.filter((_, index) => results[index]?.matched)
    if (!matchedSelectors.length) continue

    // Show every selector in the rule that actually targets this element — so a
    // grouped rule like `::before, ::after { … }` lists both halves.
    const selectorText = matchedSelectors.map((s) => s.text).join(', ')

    let conditional: boolean
    let kind: RuleKind
    let strongestBase: Hit['strongestBase'] = null
    let label: string

    if (rule.atContext.length > 0) {
      conditional = true
      kind = 'at-rule'
      label = `${rule.atContext.join(' › ')} ${selectorText}`
    } else {
      const baseSelectors = matchedSelectors.filter((s) => !subjectHasState(s.text) && s.pseudoElement == null)
      if (baseSelectors.length) {
        conditional = false
        kind = 'base'
        strongestBase = strongestOf(baseSelectors)
        label = selectorText
      } else {
        conditional = true
        kind = matchedSelectors.some((s) => s.pseudoElement != null) ? 'pseudo-element' : 'pseudo-class'
        label = selectorText
      }
    }

    hits.push({ rule, matchedSelectors, strongestBase, conditional, kind, label })
  }

  // Cascade winners among base hits, keyed by property.
  type Contribution = {
    declId: string
    prop: string
    important: boolean
    specificity: Specificity
    seq: number
    selectorText: string
    /** The source the winner was authored in, carried through the sort so a
     *  losing declaration can name the file that beat it and not only the
     *  selector — which several stylesheets can share, and here do. */
    embedKey: string
    embedLabel: string
  }
  const contributions: Contribution[] = []
  let seq = 0
  for (const hit of hits) {
    if (hit.conditional || !hit.strongestBase) continue
    for (const decl of hit.rule.declarations) {
      contributions.push({
        declId: decl.declId,
        prop: decl.prop,
        important: decl.important,
        specificity: hit.strongestBase.specificity,
        seq: seq++,
        selectorText: hit.strongestBase.selector.text,
        embedKey: hit.rule.embedKey,
        embedLabel: hit.rule.embedLabel,
      })
    }
  }

  const winners = new Map<string, Contribution>()
  const byProp = new Map<string, Contribution[]>()
  contributions.forEach((c) => {
    const list = byProp.get(c.prop) ?? []
    list.push(c)
    byProp.set(c.prop, list)
  })
  byProp.forEach((list, prop) => {
    winners.set(prop, [...list].sort((a, b) => compareCascade(a, b, a.seq, b.seq))[0])
  })

  const base: MatchedRule[] = []
  const conditional: MatchedRule[] = []

  for (const hit of hits) {
    const declStatus: Record<string, DeclStatus> = {}
    for (const decl of hit.rule.declarations) {
      if (hit.conditional) {
        // Nothing at rest overrides it, and nothing here resolved it either.
        declStatus[decl.declId] = { winning: true, overriddenBy: null, overriddenByOrigin: null, resolved: false }
        continue
      }
      const winner = winners.get(decl.prop)
      declStatus[decl.declId] =
        winner && winner.declId === decl.declId
          ? { winning: true, overriddenBy: null, overriddenByOrigin: null, resolved: true }
          : {
              winning: false,
              overriddenBy: winner ? winner.selectorText : null,
              overriddenByOrigin: winner
                ? { selector: winner.selectorText, source: winner.embedKey, sourceLabel: winner.embedLabel }
                : null,
              resolved: true,
            }
    }

    const matched: MatchedRule = {
      rule: hit.rule,
      matchedSelectors: hit.matchedSelectors,
      kind: hit.kind,
      conditional: hit.conditional,
      label: hit.label,
      declStatus,
    }
    ;(hit.conditional ? conditional : base).push(matched)
  }

  base.sort((a, b) => a.rule.order - b.rule.order)
  conditional.sort((a, b) => a.rule.order - b.rule.order)

  return { base, conditional, matchedRuleCount: hits.length }
}
