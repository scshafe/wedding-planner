import type { WeddingTask, WeddingVendor } from '@wedding-planner/shared'

/**
 * @canonical risk_signals -- what is slipping in a wedding, computed from what the app already holds (issue #62, ADR
 * 0060). Pure: the same inputs give the same signals.
 *
 * Seven signals, each present only when it counts something:
 *   - `overdue_tasks` / `tasks_due_soon`: open checklist tasks due before today / in the next 7 days;
 *   - `payments_overdue` / `payments_due_soon`: unpaid vendor installments due before today / in the next 14 days;
 *   - `rsvps_missing`: households with a guest still to answer, while RSVPs are open and the wedding is 45 days off or
 *     less;
 *   - `guests_unseated`: attending guests without a seat, 21 days off or less;
 *   - `contracts_unsigned`: vendors whose contract is not signed (nor cancelled), 90 days off or less.
 * A wedding whose day has passed has none. Each signal carries a count and at most three labels (task titles, vendor
 * names, household names) — the planner's own data, shown to the planner only.
 *
 * {@link renderRiskLine} words a signal from its own data: a summary can only state what the signals hold.
 *
 * related: risk_summary_service.ts (the weekly job), risk_simulation.ts (the simulated model's choice).
 */

export const RISK_SIGNAL_KEYS = ['overdue_tasks', 'tasks_due_soon', 'payments_overdue', 'payments_due_soon', 'rsvps_missing', 'guests_unseated', 'contracts_unsigned'] as const
export type RiskSignalKey = (typeof RISK_SIGNAL_KEYS)[number]

export interface RiskSignal {
  readonly key: RiskSignalKey
  readonly count: number
  /** At most three labels, the most urgent first. */
  readonly items: readonly string[]
}

export interface RiskSignals {
  /** The ISO week the signals were computed in, `YYYY-Www`. */
  readonly week: string
  readonly days_to_wedding: number
  readonly signals: readonly RiskSignal[]
}

/** What the signals are computed from (read by the summary's job, fresh). */
export interface RiskInputs {
  readonly today: string
  readonly event_date: string
  readonly tasks: readonly WeddingTask[]
  readonly vendors: readonly WeddingVendor[]
  readonly rsvps_closed: boolean
  /** Households with an invited guest who has not answered, by name. */
  readonly unanswered_households: readonly string[]
  /** Attending guests without a seat, by name. */
  readonly unseated_guests: readonly string[]
}

const LABELS = 3

export function computeRiskSignals(input: RiskInputs): RiskSignals {
  const days = daysBetween(input.today, input.event_date)
  const week = isoWeek(input.today)
  if (days < 0) return { week, days_to_wedding: days, signals: [] }
  const soon = shift(input.today, 7)
  const payWindow = shift(input.today, 14)
  const open = input.tasks.filter((t) => t.status === 'todo').sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.title.localeCompare(b.title)))
  const unpaid = input.vendors
    .filter((v) => v.contract_status !== 'cancelled')
    .flatMap((v) => v.installments.filter((i) => !i.paid).map((i) => ({ due: i.due_date, label: `${v.business_name} (${i.label})` })))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.label.localeCompare(b.label)))
  const signal = (key: RiskSignalKey, labels: readonly string[], count = labels.length): RiskSignal[] => (count === 0 ? [] : [{ key, count, items: labels.slice(0, LABELS) }])
  return {
    week,
    days_to_wedding: days,
    signals: [
      ...signal('overdue_tasks', open.filter((t) => t.due_date < input.today).map((t) => t.title)),
      ...signal('tasks_due_soon', open.filter((t) => t.due_date >= input.today && t.due_date <= soon).map((t) => t.title)),
      ...signal('payments_overdue', unpaid.filter((p) => p.due < input.today).map((p) => p.label)),
      ...signal('payments_due_soon', unpaid.filter((p) => p.due >= input.today && p.due <= payWindow).map((p) => p.label)),
      ...(input.rsvps_closed || days > 45 ? [] : signal('rsvps_missing', [...input.unanswered_households].sort())),
      ...(days > 21 ? [] : signal('guests_unseated', [...input.unseated_guests].sort())),
      ...(days > 90 ? [] : signal('contracts_unsigned', input.vendors.filter((v) => v.contract_status === 'none' || v.contract_status === 'sent').map((v) => v.business_name).sort())),
    ],
  }
}

/** One line of the summary, worded from the signal's own data. */
export function renderRiskLine(signal: RiskSignal, days_to_wedding: number): string {
  const n = signal.count
  const list = signal.items.length === 0 ? '' : `: ${signal.items.join(', ')}${n > signal.items.length ? `, and ${n - signal.items.length} more` : ''}`
  const plural = (one: string, many: string) => (n === 1 ? one : many)
  switch (signal.key) {
    case 'overdue_tasks':
      return `${n} ${plural('task is', 'tasks are')} overdue${list}.`
    case 'tasks_due_soon':
      return `${n} ${plural('task is', 'tasks are')} due this week${list}.`
    case 'payments_overdue':
      return `${n} ${plural('payment is', 'payments are')} overdue${list}.`
    case 'payments_due_soon':
      return `${n} ${plural('payment is', 'payments are')} due in the next two weeks${list}.`
    case 'rsvps_missing':
      return `${n} ${plural('household has', 'households have')} not answered, ${days_to_wedding} days before the wedding${list}.`
    case 'guests_unseated':
      return `${n} attending ${plural('guest has', 'guests have')} no seat, ${days_to_wedding} days before the wedding${list}.`
    case 'contracts_unsigned':
      return `${n} vendor ${plural('contract is', 'contracts are')} not signed${list}.`
  }
}

/** The ISO 8601 week of a date, `YYYY-Www` (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}
