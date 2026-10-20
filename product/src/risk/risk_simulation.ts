import type { RiskSummaryOutput } from '@wedding-planner/shared'

import type { RiskSignalKey, RiskSignals } from './risk_signals'

/**
 * @canonical risk_simulation -- what the simulated model writes for the weekly risk summary (issue #62, ADR 0060): a
 * pure, deterministic judgement of the signals, standing in for a real model.
 *
 * The level: `at_risk` when something is already late (an overdue task or payment) or close to the day (households not
 * answered with three weeks or less to go, guests without a seat with two weeks or less); `watch` when any other signal
 * is present; `on_track` when none is. It mentions the signals most urgent first, at most four.
 */

const URGENCY: readonly RiskSignalKey[] = ['payments_overdue', 'overdue_tasks', 'guests_unseated', 'rsvps_missing', 'payments_due_soon', 'tasks_due_soon', 'contracts_unsigned']

export function simulateRiskSummary(raw: Readonly<Record<string, unknown>>): RiskSummaryOutput {
  const input = raw as unknown as RiskSignals
  const present = new Set(input.signals.map((s) => s.key))
  const days = input.days_to_wedding
  const late = present.has('overdue_tasks') || present.has('payments_overdue') || (present.has('rsvps_missing') && days <= 21) || (present.has('guests_unseated') && days <= 14)
  return {
    level: present.size === 0 ? 'on_track' : late ? 'at_risk' : 'watch',
    mention: URGENCY.filter((k) => present.has(k)).slice(0, 4),
  }
}
