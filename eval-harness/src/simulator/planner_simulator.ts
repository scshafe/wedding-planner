import {
  assertValidGenome,
  classifyGenomeArtifactRef,
  type GenomeArtifactRefVerdict,
  ManualClock,
  SequentialIdGenerator,
  type StrategyGenome,
} from '@wedding-planner/shared'

import { EvalHarnessError } from '../eval_harness_error'
import { type ProductRunner } from '../scoring/offline_scorer'
import { type Planner, rsvpCadencePlanner } from './stage_a_planner'
import { observeTrustedRecord } from './stage_b_observer'

/**
 * @canonical planner_simulator -- wires Stage A (planner->claims) and Stage B (harness->trusted
 * record) into a ProductRunner the offline scorer consumes, and ENFORCES the content-address binding.
 *
 * This is the offline "product under test". It is bound at construction with the champion genome
 * (baseline) and the candidate genome + the artifact_ref the candidate committed to; the returned
 * ProductRunner stays candidate-blind at the scorer boundary (it sees only `variant`). Three guards
 * run BEFORE any run, in the order doddy named (validate -> verify-ref), and refuse-and-halt:
 *   1. Both genomes are schema-validated (the weld — an unvalidated genome must never be hashed/run).
 *   2. The candidate genome's content-address MUST equal the candidate's artifact_ref. A `mismatch`
 *      (genome substitution) or `malformed_ref` halts with a distinct, coded error — never "regenerate
 *      the ref and proceed", which would make the binding a no-op.
 *
 * Per (scenario, variant) the runner builds a fresh ManualClock + SequentialIdGenerator seeded by
 * scenario+variant, so runs replay byte-identically and event ids never collide across scenarios. It
 * calls Stage A for the events and Stage B for the trusted record, passing Stage A's output to NO ONE.
 *
 * related: stage_a_planner.ts, stage_b_observer.ts, scoring/offline_scorer.ts, shared/strategy/genome.ts.
 */

export interface PlannerSimulatorConfig {
  /** The current champion genome — the baseline a candidate must beat. Trusted; validated here. */
  readonly championGenome: StrategyGenome
  /** The proposed genome scored as the candidate variant. */
  readonly candidateGenome: StrategyGenome
  /** The artifact_ref the candidate committed to; MUST be the content-address of candidateGenome. */
  readonly candidateArtifactRef: string
  /** Injected determinism: the instant each run's ManualClock starts at (no ambient time). */
  readonly baseTimestamp: string
  /** Stage A override (default: the real rsvpCadencePlanner). Used by tests to inject a lying planner. */
  readonly planner?: Planner
}

/** Thrown when a candidate genome does not match the artifact_ref it committed to (refuse-and-halt). */
export class GenomeArtifactRefMismatchError extends EvalHarnessError {
  readonly verdict: GenomeArtifactRefVerdict

  constructor(verdict: Exclude<GenomeArtifactRefVerdict, 'match'>, artifactRef: string) {
    super(
      verdict === 'malformed_ref'
        ? 'SIMULATOR.GENOME_REF_MALFORMED'
        : 'SIMULATOR.GENOME_REF_MISMATCH',
      verdict === 'malformed_ref'
        ? `Candidate artifact_ref is not a genome content-address: '${artifactRef}' (refuse-and-halt).`
        : `Candidate genome does not match its committed artifact_ref '${artifactRef}' (substitution; refuse-and-halt).`,
      { context: { verdict, artifactRef } },
    )
    this.verdict = verdict
  }
}

/**
 * Build a ProductRunner that interprets the champion/candidate genomes through the two-stage
 * simulator. Validates both genomes and verifies the candidate's content-address binding up front,
 * throwing GenomeArtifactRefMismatchError on any non-`match` verdict.
 */
export function makePlannerSimulator(config: PlannerSimulatorConfig): ProductRunner {
  // 1. Validate first (the weld): an unvalidated genome must never reach hashing or the planner.
  assertValidGenome(config.championGenome)
  assertValidGenome(config.candidateGenome)

  // 2. Verify the candidate committed to exactly this genome (refuse-and-halt, distinct verdicts).
  const verdict = classifyGenomeArtifactRef(config.candidateGenome, config.candidateArtifactRef)
  if (verdict !== 'match') {
    throw new GenomeArtifactRefMismatchError(verdict, config.candidateArtifactRef)
  }

  const planner = config.planner ?? rsvpCadencePlanner

  return (scenario, variant) => {
    const genome = variant === 'candidate' ? config.candidateGenome : config.championGenome
    const clock = new ManualClock(config.baseTimestamp)
    const ids = new SequentialIdGenerator(`sim_${scenario.scenario_id}_${variant}`)

    // Stage A: planner claims. Stage B: harness trusted record from the scenario + TRUSTED genome
    // policy ALONE (never from A's claims) — Phase 4b extends Stage B with the genome to observe the
    // escalation outcomes it must reconcile, without ever reading productEvents.
    const productEvents = planner({ scenario, genome, clock, ids })
    const recorder = observeTrustedRecord(scenario, genome)

    return { recorder, productEvents }
  }
}
