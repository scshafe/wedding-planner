import { ProductError } from '../product_error'
import { assertDate } from '../wedding/calendar_date'

/**
 * @canonical checklist_template -- the built-in wedding checklist (issue #31, ADR 0050): what a planner does for
 * every wedding, scheduled backwards from the date. Applying it to a wedding creates one task per item, due the
 * item's offset before the wedding date. Each item's `key` is stored on its task, so applying again adds only what
 * is missing. Keys are part of the persisted format: never rename one (add a new item instead).
 *
 * related: checklist_service.ts (applies it), wedding_task_schema.json (template_key).
 */

/** How long before the wedding an item is due: whole months, or days. */
export type ChecklistOffset = { readonly months: number } | { readonly days: number }

export interface ChecklistTemplateItem {
  readonly key: string
  readonly title: string
  readonly before: ChecklistOffset
  readonly assignee: 'planner' | 'couple'
}

export const CHECKLIST_TEMPLATE: readonly ChecklistTemplateItem[] = Object.freeze([
  { key: 'set_budget', title: 'Agree the overall budget', before: { months: 12 }, assignee: 'couple' },
  { key: 'draft_guest_list', title: 'Draft the guest list', before: { months: 12 }, assignee: 'couple' },
  { key: 'book_venue', title: 'Book the venue', before: { months: 12 }, assignee: 'planner' },
  { key: 'book_photographer', title: 'Book the photographer', before: { months: 9 }, assignee: 'planner' },
  { key: 'book_caterer', title: 'Book the caterer', before: { months: 9 }, assignee: 'planner' },
  { key: 'send_save_the_dates', title: 'Send save-the-dates', before: { months: 9 }, assignee: 'couple' },
  { key: 'choose_attire', title: 'Choose the wedding attire', before: { months: 6 }, assignee: 'couple' },
  { key: 'book_music', title: 'Book the music', before: { months: 6 }, assignee: 'planner' },
  { key: 'book_florist', title: 'Book the florist', before: { months: 6 }, assignee: 'planner' },
  { key: 'send_invitations', title: 'Send the invitations', before: { months: 3 }, assignee: 'couple' },
  { key: 'plan_menu', title: 'Taste and settle the menu', before: { months: 3 }, assignee: 'planner' },
  { key: 'arrange_transport', title: 'Arrange transport', before: { months: 3 }, assignee: 'planner' },
  { key: 'chase_rsvps', title: 'Chase the missing RSVPs', before: { months: 1 }, assignee: 'couple' },
  { key: 'confirm_vendors', title: 'Confirm every vendor', before: { months: 1 }, assignee: 'planner' },
  { key: 'final_numbers', title: 'Send final numbers to the caterer', before: { days: 14 }, assignee: 'planner' },
  { key: 'seating_plan', title: 'Finish the seating plan', before: { days: 14 }, assignee: 'couple' },
  { key: 'run_of_show', title: 'Share the run of show with vendors', before: { days: 7 }, assignee: 'planner' },
  { key: 'final_payments', title: 'Make the final vendor payments', before: { days: 7 }, assignee: 'couple' },
])

/**
 * `date` (YYYY-MM-DD) moved back by `before`. Months keep the day of the month, clamped to the end of a shorter
 * month (31 March - 1 month = 28/29 February). Pure date arithmetic in UTC: no time zone shifts a date.
 */
export function dateBefore(date: string, before: ChecklistOffset): string {
  assertDate(date, 'date')
  if ('days' in before) return shiftDate(date, -before.days)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const months = y * 12 + (m - 1) - before.months
  const year = Math.floor(months / 12)
  const month = months - year * 12
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999.
  const day = new Date(0)
  day.setUTCFullYear(year, month + 1, 0)
  const lastDay = day.getUTCDate()
  day.setUTCFullYear(year, month, Math.min(d, lastDay))
  return day.toISOString().slice(0, 10)
}

/** `date` (YYYY-MM-DD) plus `days` (negative moves it earlier). Refuses a date that is not real, or a result off the calendar. */
export function shiftDate(date: string, days: number): string {
  assertDate(date, 'date')
  const moved = new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
  if (Number.isNaN(moved.getTime()) || moved.getUTCFullYear() < 1 || moved.getUTCFullYear() > 9999) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'That moves a date off the calendar.', {})
  }
  return moved.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}
