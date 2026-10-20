import type { GuestAnswerOutput } from '@wedding-planner/shared'

import { type ConciergeFacts, conciergeFactKeys, MAX_ANSWER_KEYS } from './concierge_facts'

/**
 * @canonical concierge_simulation -- what the simulated model answers for the guest concierge (issue #60, ADR 0059): a
 * pure, deterministic choice of fact keys for a guest's question, standing in for a real model.
 *
 * First a close FAQ match (the question shares at least two meaningful words with an FAQ question, or one with a short
 * one); then the logistics topics, in priority order (hotels before "where", parking before "where"); then any FAQ that
 * shares a word; else it escalates. A topic whose fact the wedding does not have escalates rather than guessing. It
 * only ever names keys the facts hold — and the concierge checks that again.
 */

/** What the concierge sends the model: the projection, and the guest's question (shortened). */
export interface GuestAnswerInput {
  readonly facts: ConciergeFacts
  readonly question: string
}

const ESCALATE: GuestAnswerOutput = Object.freeze({ action: 'escalate', facts: [] })

/** Topics in priority order: what they match, and which keys they answer with (all that the facts hold). */
const TOPICS: readonly (readonly [RegExp, (facts: ConciergeFacts, asked: Set<string>) => string[]])[] = [
  [/\b(hotels?|stay|staying|accommodations?|rooms?|lodging|block)\b/, (f) => f.hotels.map((_, i) => `hotel:${i}`)],
  [/\b(park|parking)\b/, (f) => (f.parking_info === undefined ? [] : ['parking_info'])],
  [/\b(dress|dress code|attire|wear|outfit)\b/, (f) => (f.dress_code === undefined ? [] : ['dress_code'])],
  [/\b(registry|gifts?|presents?)\b/, (f) => f.registry.map((_, i) => `registry:${i}`)],
  [/\b(travel|airport|fly|flights?|train|directions|shuttle|getting there)\b/, (f) => (f.travel === undefined ? [] : ['travel'])],
  [
    /\b(schedule|rehearsal|reception|program|itinerary|events?|brunch|dinner|party)\b/,
    // The events the question names, else all of them.
    (f, asked) => {
      const all = f.schedule.map((e, i) => ({ i, named: [...words(e.name)].some((w) => asked.has(w)) }))
      const named = all.filter((e) => e.named)
      return (named.length > 0 ? named : all).map((e) => `schedule:${e.i}`)
    },
  ],
  [/\b(when|what time|which date|what date|the date|wedding day|start time|begin|ceremony time)\b/, () => ['event_date']],
  [/\b(where|venue|location|address|place|held)\b/, (f) => (f.venue_name === undefined ? [] : ['venue_name'])],
]

const STOPWORDS = new Set(['what', 'when', 'where', 'which', 'there', 'their', 'about', 'with', 'will', 'would', 'should', 'could', 'have', 'this', 'that', 'your', 'from', 'they', 'them', 'does', 'into', 'wedding'])

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  )
}

/** The FAQ entry sharing the most meaningful words with the question, and how many. */
function bestFaq(facts: ConciergeFacts, question: Set<string>): { readonly index: number; readonly shared: number; readonly size: number } | undefined {
  let best: { index: number; shared: number; size: number } | undefined
  facts.faq.forEach((f, index) => {
    const own = words(f.question)
    const shared = [...own].filter((w) => question.has(w)).length
    if (shared > 0 && (best === undefined || shared > best.shared)) best = { index, shared, size: own.size }
  })
  return best
}

export function simulateGuestAnswer(raw: Readonly<Record<string, unknown>>): GuestAnswerOutput {
  const input = raw as unknown as GuestAnswerInput
  const facts = input.facts
  const text = input.question.toLowerCase()
  const asked = words(input.question)
  const faq = bestFaq(facts, asked)
  if (faq !== undefined && (faq.shared >= 2 || faq.size <= 2)) return { action: 'answer', facts: [`faq:${faq.index}`] }
  for (const [pattern, keysOf] of TOPICS) {
    if (!pattern.test(text)) continue
    const keys = keysOf(facts, asked).slice(0, MAX_ANSWER_KEYS)
    return keys.length === 0 ? ESCALATE : { action: 'answer', facts: keys }
  }
  if (faq !== undefined) return { action: 'answer', facts: [`faq:${faq.index}`] }
  return ESCALATE
}

/** Whether every key names a fact the projection holds (the simulation's own promise; the concierge checks it again). */
export function keysHeld(facts: ConciergeFacts, keys: readonly string[]): boolean {
  const held = conciergeFactKeys(facts)
  return keys.every((k) => held.has(k))
}
