import type { CopilotDraftOutput } from '@wedding-planner/shared'

/**
 * @canonical copilot_simulation -- what the simulated model drafts for the planner copilot (issue #61, ADR 0058): a pure,
 * deterministic function of the request's input, standing in for a real model.
 *
 * Tasks come from the wedding's vendors (one well-known step per category), its events (confirm each one's timing)
 * and a few steps every wedding needs, each due a fixed number of days before the date (never before today). Run-of-show
 * items come from the events (a final walkthrough an hour before each) and the vendors (setup and arrival times for the
 * categories that have one). Anything whose title is already on the checklist or the run of show is left out.
 *
 * Like a real model's, this output is only a proposal: copilot_service.ts checks it against the wedding before the
 * planner sees it.
 */

/** What the copilot sends the model: the facts of one wedding, by position (no ids). */
export interface CopilotDraftInput {
  readonly event_date: string
  readonly today: string
  readonly events: readonly { readonly name: string; readonly starts_at: string }[]
  readonly vendors: readonly { readonly category: string }[]
  readonly existing_task_titles: readonly string[]
  readonly existing_item_titles: readonly string[]
}

type Assignee = 'planner' | 'couple'

/** One well-known step per vendor category: what, how many days before the wedding, whose. */
const VENDOR_TASKS: Readonly<Record<string, readonly [string, number, Assignee]>> = Object.freeze({
  venue: ['Walk through the venue with its coordinator', 30, 'planner'],
  catering: ['Send the final headcount to the caterer', 10, 'planner'],
  photography: ['Send the shot list to the photographer', 14, 'couple'],
  videography: ['Agree the key moments with the videographer', 14, 'couple'],
  music: ['Share the must-play and do-not-play lists', 21, 'couple'],
  flowers: ['Confirm the flower delivery time', 7, 'planner'],
  attire: ['Book the final fitting', 21, 'couple'],
  beauty: ['Book the hair and makeup trial', 45, 'couple'],
  cake: ['Confirm the cake delivery and setup', 7, 'planner'],
  transport: ['Send the pickup times to the driver', 7, 'planner'],
  officiant: ['Review the ceremony script with the officiant', 21, 'couple'],
  stationery: ['Approve the day-of stationery proofs', 30, 'couple'],
  rentals: ['Confirm the rentals delivery and pickup', 7, 'planner'],
})

const GENERAL_TASKS: readonly (readonly [string, number, Assignee])[] = Object.freeze([
  ['Send RSVP reminders to households that have not answered', 35, 'planner'],
  ['Finalize the seating plan', 10, 'planner'],
  ['Pack an emergency kit for the day', 2, 'planner'],
])

/** Setup and arrival on the day, per vendor category: what, minutes before which event (first or last), owner vendor. */
const VENDOR_ITEMS: Readonly<Record<string, readonly [string, number, 'first' | 'last']>> = Object.freeze({
  venue: ['Venue opens for setup', 240, 'first'],
  flowers: ['Flowers delivered and placed', 150, 'first'],
  photography: ['Photographer arrives and sets up', 90, 'first'],
  videography: ['Videographer arrives and sets up', 90, 'first'],
  catering: ['Catering setup', 120, 'last'],
  music: ['Sound check', 45, 'last'],
})

export function simulateCopilotDraft(raw: Readonly<Record<string, unknown>>): CopilotDraftOutput {
  const input = raw as unknown as CopilotDraftInput
  const taken = new Set([...input.existing_task_titles, ...input.existing_item_titles].map((t) => t.trim().toLowerCase()))
  const fresh = (title: string): boolean => {
    const key = title.toLowerCase()
    if (taken.has(key)) return false
    taken.add(key)
    return true
  }
  const tasks: CopilotDraftOutput['tasks'] = []
  const addTask = (title: string, days: number, assignee: Assignee): void => {
    if (input.today > input.event_date || !fresh(title)) return
    const due = shiftDays(input.event_date, -days)
    tasks.push({ title, due_date: due < input.today ? input.today : due, assignee })
  }
  input.vendors.forEach((v) => {
    const step = VENDOR_TASKS[v.category]
    if (step !== undefined) addTask(...step)
  })
  input.events.forEach((e) => addTask(`Confirm the timing of ${e.name.slice(0, 90)}`, 7, 'planner'))
  GENERAL_TASKS.forEach((step) => addTask(...step))

  const run_of_show: CopilotDraftOutput['run_of_show'] = []
  const order = input.events.map((e, index) => ({ e, index })).sort((a, b) => (a.e.starts_at < b.e.starts_at ? -1 : a.e.starts_at > b.e.starts_at ? 1 : 0))
  input.events.forEach((e, index) => {
    const title = `Final walkthrough: ${e.name.slice(0, 90)}`
    if (fresh(title)) run_of_show.push({ title, starts_at: shiftMinutes(e.starts_at, -60), owner: 'planner', event_index: index })
  })
  const first = order[0]
  const last = order[order.length - 1]
  input.vendors.forEach((v, vendor_index) => {
    const item = VENDOR_ITEMS[v.category]
    const anchor = item === undefined ? undefined : item[2] === 'first' ? first : last
    if (item === undefined || anchor === undefined || !fresh(item[0])) return
    run_of_show.push({ title: item[0], starts_at: shiftMinutes(anchor.e.starts_at, -item[1]), owner: 'vendor', vendor_index, event_index: anchor.index })
  })
  return { tasks, run_of_show }
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function shiftMinutes(local: string, minutes: number): string {
  return new Date(Date.parse(`${local}:00.000Z`) + minutes * 60_000).toISOString().slice(0, 16)
}
