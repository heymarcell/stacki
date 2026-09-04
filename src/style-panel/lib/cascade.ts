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
  overriddenByOrigin: { selector: string; atContext: string[]; source: string; sourceLabel: string } | null
  /**
   * Whether `winning` is the result of a cascade at all.
   *
   * False for a conditional rule that was not resolved: it applies only inside
   * its @media query or its interaction state, and deciding it needs a viewport
   * and a pointer. Given a viewport, a media query's declarations ARE part of
   * the resting cascade and this is true for them too.
   */
  resolved: boolean
  /**
   * Whether the rule's own condition holds at the viewport this model was
   * computed for. Null is "nothing here could decide": no viewport was given,
   * or the condition is not about one (`prefers-color-scheme`, `@supports`).
   * Always true for an unconditional rule.
   */
  applies: boolean | null
  /**
   * Rules that set this same property under a condition nobody could decide.
   *
   * Only ever on a declaration that would otherwise be reported the winner. One
   * entry means `winning` is not a claim anybody is entitled to make — the
   * conditional rule may be the value the element actually has.
   */
  contestedBy: Array<{ selector: string; atContext: string[]; source: string; sourceLabel: string }> | null
}

/** The viewport a cascade is being resolved for, in CSS pixels. */
export type Viewport = { width: number; height?: number | null } | null

// ─────────────────────────── @-context conditions ───────────────────────────
//
// A MEDIA QUERY IS NOT AN INTERACTION STATE. At a viewport where it matches,
// its declarations are the resting cascade, and the base declaration they beat
// is not the winner — reporting one as `winning` beside a `computed` that says
// otherwise is two answers to one question, and the reader has no way to know
// which to believe. So when the viewport is known, the condition is evaluated
// and the winner is the winner THERE.
//
// Only what a viewport can decide is decided here. `prefers-color-scheme`,
// `hover`, `print` and `@supports` depend on the device, the pointer and the
// engine — none of which this module is given — and those come back null.
// Null is not false: a property such a rule might set stops claiming a winner
// rather than claiming the wrong one.

/** A media length in CSS pixels, or null for a unit that is not one. */
function pxOf(text: string): number | null {
  const parsed = /^\s*(-?[\d.]+)\s*([a-z]*)\s*$/i.exec(text)
  if (!parsed) return null
  const value = Number(parsed[1])
  if (!Number.isFinite(value)) return null
  switch ((parsed[2] || 'px').toLowerCase()) {
    case 'px':
      return value
    // In a media query font-relative units resolve against the INITIAL font
    // size — the query is asked before any element exists — which is 16px
    // unless the person has changed their browser's default. Said out loud
    // because it is an assumption, and the only one here.
    case 'em':
    case 'rem':
      return value * 16
    case 'pt':
      return value * (96 / 72)
    case 'pc':
      return value * 16
    case 'in':
      return value * 96
    case 'cm':
      return value * (96 / 2.54)
    case 'mm':
      return value * (96 / 25.4)
    case 'q':
      return value * (96 / 25.4 / 4)
    default:
      return null
  }
}

const sizeOf = (feature: string, viewport: Viewport): number | null => {
  if (!viewport) return null
  if (feature === 'width') return Number.isFinite(viewport.width) ? viewport.width : null
  if (feature === 'height') return typeof viewport.height === 'number' && Number.isFinite(viewport.height) ? viewport.height : null
  return null
}

/** One `(…)` feature test. */
function featureApplies(text: string, viewport: Viewport): boolean | null {
  const body = text.trim().replace(/^\(/, '').replace(/\)$/, '').trim()
  const colon = /^([a-z-]+)\s*:\s*(.+)$/i.exec(body)
  if (colon) {
    const name = colon[1].toLowerCase()
    const bound = /^(min|max)-(width|height)$/.exec(name)
    if (bound) {
      const have = sizeOf(bound[2], viewport)
      const want = pxOf(colon[2])
      if (have == null || want == null) return null
      return bound[1] === 'min' ? have >= want : have <= want
    }
    if (name === 'width' || name === 'height') {
      const have = sizeOf(name, viewport)
      const want = pxOf(colon[2])
      if (have == null || want == null) return null
      return have === want
    }
    if (name === 'orientation') {
      const w = sizeOf('width', viewport)
      const h = sizeOf('height', viewport)
      if (w == null || h == null) return null
      return colon[2].trim().toLowerCase() === (h > w ? 'portrait' : 'landscape')
    }
    return null // prefers-*, pointer, resolution, colour depth: not a viewport
  }
  // Range syntax with one comparison: `(width >= 50em)`, `(50em <= width)`.
  const range = /^([a-z-]+|-?[\d.]+[a-z]*)\s*(<=|>=|<|>|=)\s*([a-z-]+|-?[\d.]+[a-z]*)$/i.exec(body)
  if (range) {
    const [, left, op, right] = range
    const feature = /^(width|height)$/i.test(left) ? left.toLowerCase() : /^(width|height)$/i.test(right) ? right.toLowerCase() : null
    if (!feature) return null
    const have = sizeOf(feature, viewport)
    const want = pxOf(feature === left.toLowerCase() ? right : left)
    if (have == null || want == null) return null
    // `50em <= width` is `width >= 50em`: the comparison is written from the
    // side the feature is not on.
    const flipped = feature !== left.toLowerCase()
    const compare = flipped ? { '<=': '>=', '>=': '<=', '<': '>', '>': '<', '=': '=' }[op] : op
    switch (compare) {
      case '<=':
        return have <= want
      case '>=':
        return have >= want
      case '<':
        return have < want
      case '>':
        return have > want
      default:
        return have === want
    }
  }
  return null
}

/** `a and b`, where an undecidable half only sinks the answer if nothing is false. */
const allOf = (parts: Array<boolean | null>): boolean | null =>
  parts.some((p) => p === false) ? false : parts.some((p) => p == null) ? null : true

/** A comma-separated query list: any true wins, all false loses. */
const anyOf = (parts: Array<boolean | null>): boolean | null =>
  parts.some((p) => p === true) ? true : parts.some((p) => p == null) ? null : false

/** Split on a top-level separator, ignoring anything inside brackets. */
function splitOutside(text: string, separator: RegExp): string[] {
  const out: string[] = []
  let depth = 0
  let at = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth) continue
    const rest = text.slice(i)
    const hit = separator.exec(rest)
    if (hit && hit.index === 0) {
      out.push(text.slice(at, i))
      i += hit[0].length - 1
      at = i + 1
    }
  }
  out.push(text.slice(at))
  return out.map((p) => p.trim()).filter(Boolean)
}

/** One media query — `screen and (min-width: 50em)`. */
function queryApplies(query: string, viewport: Viewport): boolean | null {
  let text = query.trim()
  let negated = false
  if (/^not\s+/i.test(text)) {
    negated = true
    text = text.replace(/^not\s+/i, '')
  } else if (/^only\s+/i.test(text)) {
    text = text.replace(/^only\s+/i, '')
  }
  const parts = splitOutside(text, /^\s+and\s+/i)
  const decided = parts.map((part) => {
    if (part.startsWith('(')) return featureApplies(part, viewport)
    const type = part.trim().toLowerCase()
    // A canvas is a screen. `print` and `speech` are not this document.
    if (type === 'screen' || type === 'all') return true
    if (type === 'print' || type === 'speech') return false
    return null
  })
  const answer = allOf(decided)
  return negated ? (answer == null ? null : !answer) : answer
}

/**
 * Whether a rule's whole at-context holds at this viewport.
 *
 * `atContext` is the nesting as css.ts records it — `['@media (min-width: 50em)',
 * '@supports (display: grid)']` — and every level has to hold.
 */
export function atContextApplies(atContext: string[] | null | undefined, viewport: Viewport): boolean | null {
  const levels = (atContext || []).map((entry) => {
    const at = /^@([a-z-]+)\s*(.*)$/i.exec(String(entry).trim())
    if (!at) return null
    const name = at[1].toLowerCase()
    if (name !== 'media') return null // @supports, @container, @layer: not a viewport question
    return anyOf(splitOutside(at[2], /^\s*,\s*/).map((query) => queryApplies(query, viewport)))
  })
  return allOf(levels)
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
  /** Whether its at-context holds at the viewport; true for an unconditional rule. */
  applies: boolean | null
  /** Whether it would style the element AT REST if its condition held — false
   *  for `@media (…) { .x:hover }`, which the pointer decides, not the width. */
  restsHere: boolean
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

export async function computeRuleModel(
  rules: ParsedRule[],
  target: MatchTarget,
  { viewport = null }: { viewport?: Viewport } = {},
): Promise<RuleModel> {
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
    let applies: boolean | null = true
    let restsHere = true

    if (rule.atContext.length > 0) {
      conditional = true
      kind = 'at-rule'
      label = `${rule.atContext.join(' › ')} ${selectorText}`
      applies = atContextApplies(rule.atContext, viewport)
      // AT A VIEWPORT WHERE IT HOLDS, IT IS THE RESTING CASCADE. It still shows
      // as conditional — the reader wants to see the query it is under — but it
      // takes part in the cascade like any other rule, at its own specificity
      // and its own place in the document. Unless its SUBJECT is a state as
      // well, in which case the pointer decides it and no width can.
      const restingSelectors = matchedSelectors.filter((s) => !subjectHasState(s.text) && s.pseudoElement == null)
      restsHere = restingSelectors.length > 0
      if (applies === true && restsHere) strongestBase = strongestOf(restingSelectors)
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

    hits.push({ rule, matchedSelectors, strongestBase, conditional, kind, label, applies, restsHere })
  }

  // Cascade winners among base hits, keyed by property.
  type Contribution = {
    declId: string
    prop: string
    important: boolean
    specificity: Specificity
    seq: number
    selectorText: string
    /** The query it was authored under, if any. Two rules with the SAME
     *  selector, one of them inside `@media`, is the ordinary way a media
     *  query overrides a base declaration — and naming only the selector
     *  makes the winner indistinguishable from the loser. */
    atContext: string[]
    /** The source the winner was authored in, carried through the sort so a
     *  losing declaration can name the file that beat it and not only the
     *  selector — which several stylesheets can share, and here do. */
    embedKey: string
    embedLabel: string
  }
  const contributions: Contribution[] = []
  // What sets this property under a condition nobody could decide. A base
  // declaration with an entry here is not entitled to call itself the winner:
  // the undecidable rule may be the value the element actually has, which is
  // exactly the contradiction a reader hits when `computed` disagrees with it.
  const undecided = new Map<string, DeclStatus['contestedBy']>()
  let seq = 0
  for (const hit of hits) {
    // Only a rule that would style the element at rest can contest the resting
    // winner: `@media (…) { .x:hover }` never does, whatever its width says.
    if (hit.applies == null && hit.kind === 'at-rule' && hit.restsHere) {
      for (const decl of hit.rule.declarations) {
        const list = undecided.get(decl.prop) ?? []
        if (!list.some((c) => c.selector === hit.label)) {
          list.push({
            selector: hit.matchedSelectors.map((s) => s.text).join(', '),
            atContext: hit.rule.atContext || [],
            source: hit.rule.embedKey,
            sourceLabel: hit.rule.embedLabel,
          })
        }
        undecided.set(decl.prop, list)
      }
    }
    // A conditional rule that HOLDS here contributes: `strongestBase` is set
    // for exactly those, and null for the ones the viewport ruled out or could
    // not decide.
    if (!hit.strongestBase) continue
    for (const decl of hit.rule.declarations) {
      contributions.push({
        declId: decl.declId,
        prop: decl.prop,
        important: decl.important,
        specificity: hit.strongestBase.specificity,
        seq: seq++,
        selectorText: hit.strongestBase.selector.text,
        atContext: hit.rule.atContext || [],
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
      if (!hit.strongestBase) {
        // Nothing at rest overrides it, and nothing here resolved it either.
        declStatus[decl.declId] = {
          winning: true,
          overriddenBy: null,
          overriddenByOrigin: null,
          resolved: false,
          applies: hit.applies,
          contestedBy: null,
        }
        continue
      }
      const winner = winners.get(decl.prop)
      const wins = !!winner && winner.declId === decl.declId
      declStatus[decl.declId] = wins
        ? {
            winning: true,
            overriddenBy: null,
            overriddenByOrigin: null,
            resolved: true,
            applies: hit.applies,
            // Only on the winner: a declaration that already lost to another
            // one lost whatever the undecidable rule turns out to say.
            contestedBy: undecided.get(decl.prop) ?? null,
          }
        : {
            winning: false,
            overriddenBy: winner ? winner.selectorText : null,
            overriddenByOrigin: winner
              ? {
                  selector: winner.selectorText,
                  atContext: winner.atContext,
                  source: winner.embedKey,
                  sourceLabel: winner.embedLabel,
                }
              : null,
            resolved: true,
            applies: hit.applies,
            contestedBy: null,
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
