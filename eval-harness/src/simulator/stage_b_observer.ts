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
 * PHASE-3 (reminder_spacing): deliberately UNCHANGED, and that is the load-bearing point. A knob that
 * only modulates the GROUND-TRUTH-DERIVED computation (spacing changes how many nudges land and how
 * gentle they are, but a guest still resolves only if its true need is met) MANUFACTURES NO OUTCOME,
 * so it opens no new self-report-divergence surface and needs no new trusted observation here. The
 * contrast that defines the line: a knob that let the product AUTHOR a resolution the guest never gave
 * (e.g. an escalate-to-couple knob that marks a never-responder resolved) WOULD be a forge-able
 * outcome — it would require Stage B to independently observe the escalation/resolution and an
 * integrity-gate effect kind to reconcile it. We deliberately did NOT add such a knob (it is also
 * tier-2; see memory: second-genome-knob-must-stay-tier1). Forge-free knob => Stage B unchanged.
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
