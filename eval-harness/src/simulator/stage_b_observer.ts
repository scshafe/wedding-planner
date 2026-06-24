import type { GuestPersona, StrategyGenome } from '@wedding-planner/shared'

import { TrustedRecorder } from '../trusted_recorder/trusted_recorder'
import { type ScenarioDefinition } from '../scoring/offline_scorer'
import {
  COUPLE_SESSION_ACTIVE_SECONDS,
  effectiveNudges,
  escalationBudget,
  isCoupleResolvable,
  NEVER,
  REMINDERS_NEEDED,
  spacingCapacity,
} from './domain_facts'

/**
 * @canonical stage_b_observer -- STAGE B of the planner simulator: the harness's independent record.
 *
 * Stage B is "the harness observing the sandboxed run". It authors the TrustedRecorder — the security
 * ground truth the veto gates read — from the SCENARIO's persona ground truth and the TRUSTED genome
 * policy ALONE. It is handed the scenario + genome and NOTHING from Stage A: it never sees the planner's
 * claimed events. That independence is what keeps INTEGRITY.SELF_REPORT_DIVERGENCE non-vacuous
 * (rigorous-architect, Phase-2): a lying Stage A cannot make Stage B corroborate the lie, so the gate
 * can still catch a forged/suppressed effect. This is the offline embodiment of the trusted_recorder
 * DEFERRED FEED-PATH INVARIANT — the trusted value comes from the harness's observation, never from
 * anything the product authored.
 *
 * PHASE-4b (escalate-to-couple). Reading the genome here does NOT break independence: the genome is the
 * trusted, content-addressed, schema-validated artifact (verified at the simulator boundary), not a
 * product claim, and Stage B still never reads `productEvents`. The discipline (rigorous-architect C2 +
 * doddy P1-3): Stage B shares the ground-truth FACTS with Stage A (domain_facts.ts: REMINDERS_NEEDED,
 * spacingCapacity, couple-resolvability, the escalation budget) but re-derives the trusted OUTCOME by
 * its OWN computation below — it must NEVER import Stage A's `guestOutcome`/emission path, or a bug in
 * one stage would corrupt both sides identically and re-vacuum the gate. The honest Stage A reproduces
 * exactly this set; a lying Stage A (test double) deviates and the integrity gate vetoes it.
 *
 * What Stage B authors:
 *   - hard-constraint determinations (the modeled planner respects the couple's hard constraints);
 *   - a trusted RSVP OUTCOME for every guest this genome's policy actually resolves — reminder-resolved
 *     (delivered >= ground-truth need) UNION couple-resolved (a still-pending, couple-resolvable guest
 *     the escalation policy reaches). This is the trusted backing for the claimed resolution numerator;
 *   - a trusted COUPLE SESSION (the couple-attention cost) for each escalated guest — the trusted
 *     backing for the claimed effort_cost denominator.
 * A guest reminders alone do not reach AND the policy does not escalate has NO outcome record: claiming
 * its resolution is then a forge. couple-resolvability is a SCENARIO fact, never a genome field, so a
 * genome cannot assert a guest resolvable.
 *
 * related: stage_a_planner.ts (the claims it is independent of), trusted_recorder.ts, domain_facts.ts,
 * gates/integrity_gate.ts.
 */

/** A constraint severity the trusted recorder accepts; defaults to 'serious' when unspecified. */
type ConstraintSeverity = 'fatal' | 'serious' | 'moderate'

/** The rsvp_status a resolved guest truly gives, from their ground-truth intent (mirrors Stage A). */
function resolvedStatus(guest: GuestPersona): 'yes' | 'no' {
  return guest.rsvp_truth.will_attend === 'no' ? 'no' : 'yes'
}

/**
 * Whether reminders ALONE resolve this guest under the genome's cadence/spacing/batching (Stage B's OWN
 * calc, sharing only the FACTS with Stage A — never its emission path). PHASE-5: batching dilutes reach,
 * so resolution requires `effectiveNudges(delivered, batching) >= needed` — the IDENTICAL computation
 * Stage A applies. This mirror is load-bearing: without it an honest batched genome's claimed resolutions
 * would diverge from the trusted record and the integrity gate would veto every honest tier-1 run.
 */
function reminderResolves(guest: GuestPersona, cadence: number, spacing: number, batching: number): boolean {
  const needed = REMINDERS_NEEDED[guest.rsvp_truth.response_latency] ?? NEVER
  const delivered = Math.min(cadence, spacingCapacity(spacing))
  return needed !== NEVER && effectiveNudges(delivered, batching) >= needed
}

/**
 * Build the trusted record for one scenario from persona ground truth + the trusted genome policy only.
 * Reads the scenario and the genome; never reads Stage A output.
 */
export function observeTrustedRecord(
  scenario: ScenarioDefinition,
  genome: StrategyGenome,
): TrustedRecorder {
  const recorder = new TrustedRecorder()

  for (const hardConstraint of scenario.couple.hard_constraints) {
    recorder.recordConstraintDetermination({
      constraint_id: hardConstraint.constraint_id,
      constraint_type: hardConstraint.type,
      satisfied: true,
      severity: (hardConstraint.severity as ConstraintSeverity | undefined) ?? 'serious',
      plan_element_ref: null,
    })
  }

  const cadence = genome.parameters.rsvp_reminder_cadence
  const spacing = genome.parameters.reminder_spacing
  const batching = genome.parameters.reminder_batching
  const autonomyThreshold = genome.parameters.autonomy_threshold

  // Reminder-resolved guests (the same ground-truth need the cadence/spacing/batching reach satisfies).
  const pending: GuestPersona[] = []
  for (const guest of scenario.guests) {
    if (reminderResolves(guest, cadence, spacing, batching)) {
      recorder.recordRsvpOutcome({
        guest_id: guest.persona_id,
        rsvp_status: resolvedStatus(guest),
        resolved_via: 'reminder',
      })
    } else {
      pending.push(guest)
    }
  }

  // Couple-resolved guests: only when the tier-2 escalation knob is present. Escalate the first
  // `escalationBudget(threshold)` still-pending, couple-resolvable guests (deterministic persona order).
  // Each consumes a couple session (the cost) and the couple resolves them (the value).
  if (autonomyThreshold !== undefined) {
    const candidates = pending
      .filter((guest) => isCoupleResolvable(guest))
      .sort((a, b) => a.persona_id.localeCompare(b.persona_id))
    const budget = escalationBudget(autonomyThreshold)
    for (let i = 0; i < candidates.length && i < budget; i += 1) {
      const guest = candidates[i] as GuestPersona
      recorder.recordCoupleSession({
        guest_id: guest.persona_id,
        active_seconds: COUPLE_SESSION_ACTIVE_SECONDS,
      })
      recorder.recordRsvpOutcome({
        guest_id: guest.persona_id,
        rsvp_status: resolvedStatus(guest),
        resolved_via: 'couple',
      })
    }
  }

  return recorder
}
