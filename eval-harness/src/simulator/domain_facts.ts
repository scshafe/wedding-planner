import type { GuestPersona } from '@wedding-planner/shared'

import { type ScenarioDefinition } from '../scoring/offline_scorer'

/**
 * @canonical domain_facts -- the SHARED ground-truth FACTS of the RSVP world, read by BOTH simulator
 * stages. This module is the one place the line "share the FACT, never the CLAIM" is drawn (Phase 4b,
 * rigorous-architect C2 + doddy P1-3).
 *
 * Stage A (the planner, claims) and Stage B (the harness, trusted record) must agree on the ground
 * truth of the world — how many reminders a latency needs, and which guests the COUPLE can personally
 * resolve — or the integrity gate would diverge on honest runs. So those FACTS live here and both
 * stages import them. But each stage applies the genome POLICY to these facts BY ITS OWN computation:
 * Stage A authors product events (and a LYING Stage A may deviate), Stage B authors the trusted record.
 * Nothing here authors a claim or a trusted record, and Stage B never imports Stage A's event-emission
 * path — so a bug in one stage cannot corrupt both identically and re-vacuum the gate. Sharing the
 * domain CONSTANT is safe; sharing the claim path would not be.
 *
 * related: stage_a_planner.ts (policy → claims), stage_b_observer.ts (policy → trusted record).
 */

/** Sentinel for a guest who never responds to AI reminders regardless of cadence/spacing. */
export const NEVER = Number.POSITIVE_INFINITY

/**
 * Reminders a guest needs before they resolve via NUDGES, from their ground-truth `response_latency`.
 * A `never` responder cannot be resolved by reminders at any cadence (only, possibly, by the couple).
 */
export const REMINDERS_NEEDED: Readonly<Record<string, number>> = {
  immediate: 0,
  after_one_reminder: 1,
  after_multiple_reminders: 2,
  never: NEVER,
}

/**
 * The ground-truth set of guests the COUPLE can personally resolve when the planner escalates them
 * (the `rsvp_truth.couple_resolvable` persona fact). This is a SCENARIO fact, genome-free: the genome
 * decides the escalation POLICY, this decides who is actually resolvable. A guest absent from this set
 * cannot have their resolution manufactured by an escalation — claiming otherwise is a forge.
 */
export function coupleResolvableGuestIds(scenario: ScenarioDefinition): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const guest of scenario.guests) {
    if (isCoupleResolvable(guest)) {
      ids.add(guest.persona_id)
    }
  }
  return ids
}

/** Whether one guest is ground-truth couple-resolvable (defaults to false when the fact is absent). */
export function isCoupleResolvable(guest: GuestPersona): boolean {
  return guest.rsvp_truth.couple_resolvable === true
}
