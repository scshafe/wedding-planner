import { TrustedRecorder } from '../trusted_recorder/trusted_recorder'
import { type ScenarioDefinition } from '../scoring/offline_scorer'

/**
 * @canonical stage_b_observer -- STAGE B of the planner simulator: the harness's independent record.
 *
 * Stage B is "the harness observing the sandboxed run". It authors the TrustedRecorder — the security
 * ground truth the veto gates read — from the SCENARIO's persona ground truth ALONE. It is handed the
 * scenario and NOTHING from Stage A: it never sees the planner's claimed events. That independence is
 * what keeps INTEGRITY.SELF_REPORT_DIVERGENCE non-vacuous (rigorous-architect, Phase-2): a lying
 * Stage A cannot make Stage B corroborate the lie, so the gate can still catch a forged/suppressed
 * effect. This is the offline embodiment of the trusted_recorder DEFERRED FEED-PATH INVARIANT — the
 * trusted value comes from the harness's observation, never from anything the product authored.
 *
 * For the rsvp_reminder_cadence model the planner makes no commitments/integration actions, so the
 * trusted record carries only the hard-constraint determinations (the planner is modeled to satisfy
 * the couple's hard constraints — the baseline assumption a candidate must not break). When later
 * genomes drive spend/booking/comms, THIS is where the harness observes those effects out-of-band.
 *
 * related: stage_a_planner.ts (the claims it is independent of), trusted_recorder.ts, gates/integrity_gate.ts.
 */

/** A constraint severity the trusted recorder accepts; defaults to 'serious' when unspecified. */
type ConstraintSeverity = 'fatal' | 'serious' | 'moderate'

/**
 * Build the trusted record for one scenario from persona ground truth only. Records each of the
 * couple's hard constraints as satisfied (the modeled planner respects hard constraints). Reads the
 * scenario; never reads Stage A output.
 */
export function observeTrustedRecord(scenario: ScenarioDefinition): TrustedRecorder {
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
  return recorder
}
