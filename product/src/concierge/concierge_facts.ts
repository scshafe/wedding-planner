import type { Wedding } from '@wedding-planner/shared'

import type { PublicSiteView } from '../site/site_service'

/**
 * @canonical concierge_facts -- what the guest concierge may answer from, and how an answer is worded (issue #60, ADR
 * 0059).
 *
 * THE SECURITY BOUNDARY IS THE PROJECTION. {@link projectConciergeFacts} is an explicit allow-list: the wedding's
 * guest-shareable logistics (the couple's name, the date, ceremony time, venue, parking, dress code) and — only while
 * the wedding website is published — the website's public content (the public events, travel notes, hotel blocks, the
 * FAQ, registry links), which `SiteService` already reduces to an allow-list. Never a guest, a count, an RSVP, a
 * planner note or an id. A fact the projection does not hold cannot reach a guest.
 *
 * THE MODEL ONLY POINTS. Each fact has a key ({@link conciergeFactKeys}: `event_date`, `faq:2`, `hotel:0`, …). The model
 * answers with keys, never with text; {@link renderConciergeAnswer} words the reply from the trusted values of keys the
 * projection holds. So a reply can only ever say what the projection says, and never echoes the guest's message.
 *
 * related: concierge_service.ts (the job that asks), concierge_simulation.ts (the simulated model's choice),
 * site_service.ts (the website's public view).
 */

/** The facts a guest may be told. Every list comes from the published website (empty while it is not published). */
export interface ConciergeFacts {
  readonly couple_display_name: string
  readonly event_date: string
  readonly ceremony_time?: string
  readonly venue_name?: string
  readonly parking_info?: string
  readonly dress_code?: string
  readonly travel?: string
  readonly schedule: readonly { readonly name: string; readonly starts_at: string; readonly location?: string }[]
  readonly hotels: readonly { readonly name: string; readonly address?: string; readonly booking_url?: string; readonly block_code?: string; readonly book_by?: string }[]
  readonly faq: readonly { readonly question: string; readonly answer: string }[]
  readonly registry: readonly { readonly label: string; readonly url: string }[]
}

/** The facts' single-valued keys (the lists are `schedule:N`, `hotel:N`, `faq:N`, `registry:N`). */
export const SINGLE_FACT_KEYS = ['event_date', 'ceremony_time', 'venue_name', 'parking_info', 'dress_code', 'travel'] as const

/** The most keys one answer may use. */
export const MAX_ANSWER_KEYS = 3

/** The longest reply: a few text messages' worth. Longer facts are cut at a word. */
export const MAX_REPLY_LENGTH = 600

/** Build the allow-listed projection. Explicit fields only, never a spread: anything not named here stays private. */
export function projectConciergeFacts(wedding: Wedding, site: PublicSiteView | undefined): ConciergeFacts {
  const optional = <K extends string>(key: K, value: string | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, string>))
  return {
    couple_display_name: wedding.couple_display_name,
    event_date: wedding.event_date,
    ...optional('ceremony_time', wedding.ceremony_time),
    ...optional('venue_name', wedding.venue_name),
    ...optional('parking_info', wedding.parking_info),
    ...optional('dress_code', wedding.dress_code),
    ...optional('travel', site?.travel),
    schedule: (site?.schedule ?? []).map((e) => ({ name: e.name, starts_at: e.starts_at, ...optional('location', e.location) })),
    hotels: (site?.hotels ?? []).map((h) => ({
      name: h.name,
      ...optional('address', h.address),
      ...optional('booking_url', h.booking_url),
      ...optional('block_code', h.block_code),
      ...optional('book_by', h.book_by),
    })),
    faq: (site?.faq ?? []).map((f) => ({ question: f.question, answer: f.answer })),
    registry: (site?.registry ?? []).map((r) => ({ label: r.label, url: r.url })),
  }
}

/** Every key the projection holds (a key for an absent fact is not one). */
export function conciergeFactKeys(facts: ConciergeFacts): ReadonlySet<string> {
  const keys = new Set<string>(SINGLE_FACT_KEYS.filter((k) => facts[k] !== undefined))
  facts.schedule.forEach((_, i) => keys.add(`schedule:${i}`))
  facts.hotels.forEach((_, i) => keys.add(`hotel:${i}`))
  facts.faq.forEach((_, i) => keys.add(`faq:${i}`))
  facts.registry.forEach((_, i) => keys.add(`registry:${i}`))
  return keys
}

/**
 * The reply for some keys, worded from the trusted values only. Keys the projection does not hold are skipped (the
 * caller has already refused an answer that names one); the result is cut to {@link MAX_REPLY_LENGTH}.
 */
export function renderConciergeAnswer(facts: ConciergeFacts, keys: readonly string[]): string {
  const who = facts.couple_display_name
  const sentences = keys.slice(0, MAX_ANSWER_KEYS).flatMap((key): string[] => {
    const [kind, index] = key.split(':') as [string, string | undefined]
    const at = index === undefined ? -1 : Number(index)
    switch (kind) {
      case 'event_date':
        return [facts.ceremony_time === undefined ? `${who}'s wedding is on ${facts.event_date}.` : `${who}'s wedding is on ${facts.event_date} at ${facts.ceremony_time}.`]
      case 'ceremony_time':
        return facts.ceremony_time === undefined ? [] : [`The ceremony starts at ${facts.ceremony_time}.`]
      case 'venue_name':
        return facts.venue_name === undefined ? [] : [`${who}'s wedding will be held at ${facts.venue_name}.`]
      case 'parking_info':
        return facts.parking_info === undefined ? [] : [`Parking: ${facts.parking_info}`]
      case 'dress_code':
        return facts.dress_code === undefined ? [] : [`The dress code is ${facts.dress_code}.`]
      case 'travel':
        return facts.travel === undefined ? [] : [`Travel: ${facts.travel}`]
      case 'schedule': {
        const e = facts.schedule[at]
        return e === undefined ? [] : [`${e.name}: ${e.starts_at.replace('T', ' at ')}${e.location === undefined ? '' : `, ${e.location}`}.`]
      }
      case 'hotel': {
        const h = facts.hotels[at]
        if (h === undefined) return []
        const parts = [h.address, h.block_code === undefined ? undefined : `block code ${h.block_code}`, h.book_by === undefined ? undefined : `book by ${h.book_by}`, h.booking_url]
        return [`Hotel: ${h.name}${parts.some((p) => p !== undefined) ? ` (${parts.filter((p) => p !== undefined).join(', ')})` : ''}.`]
      }
      case 'faq': {
        const f = facts.faq[at]
        return f === undefined ? [] : [f.answer]
      }
      case 'registry': {
        const r = facts.registry[at]
        return r === undefined ? [] : [`Registry: ${r.label} ${r.url}`]
      }
      default:
        return []
    }
  })
  return cut(sentences.join(' '), MAX_REPLY_LENGTH)
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const space = text.lastIndexOf(' ', max - 1)
  let end = space > max / 2 ? space : max - 1
  // Never split a surrogate pair (an emoji): the reply must stay well-formed text.
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}
