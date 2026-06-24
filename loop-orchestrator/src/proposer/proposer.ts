import {
  type CandidateChange,
  type Clock,
  getSchemaRegistry,
  type IdGenerator,
} from '@wedding-planner/shared'

/**
 * The proposer is the loop's only model-authored step (proposer_design.md): it emits a schema-valid,
 * hypothesis-first candidate_change and nothing more — everything downstream is deterministic. Phase 1
 * ships a scripted STUB proposer (the creative Claude-Agent-SDK proposer comes once the gate is
 * trusted); it still produces a falsifiable hypothesis so the surprise check and the lessons loop work.
 *
 * A proposer NEVER advances its own candidate past `implemented` — that separation is what lets a
 * high-variance proposer be safe.
 *
 * related: loop/offline_loop.ts, pipeline/deterministic_selector.ts.
 */

export interface ProposerContext {
  /** The current loop iteration (0-based). */
  readonly iteration: number
  /** The weakest capability from the latest scorecard, the proposer's primary target. */
  readonly weakestCapability: string | null
  /** Accumulated ledger lessons — dead ideas the proposer must not re-litigate. */
  readonly lessons: readonly string[]
}

export interface Proposer {
  /** Emit the next candidate, or null when the proposer has no more ideas for the current target. */
  propose(context: ProposerContext): CandidateChange | null
  /**
   * Optional terminal certificate (Phase 3). When propose() returns null, a proposer that searches a
   * bounded space may report whether it CONVERGED — i.e. it exhausted the whole space against the
   * standing baseline with nothing accepted — versus merely running out for some other reason. The
   * loop turns a true return into the `converged` termination reason (a "no acceptable point against
   * the standing champion" certificate), and a missing/false return into the generic
   * `proposer_exhausted`. A proposer that generates indefinitely (e.g. the stub) omits it.
   */
  isConverged?(): boolean
}

export interface StubProposerSpec {
  readonly target_capability: CandidateChange['hypothesis']['target_capability']
  readonly target_metric_code: string
  readonly expected_direction: CandidateChange['hypothesis']['expected_direction']
  readonly guards_to_watch: readonly string[]
  readonly target_scenario_ids?: readonly string[]
  readonly change_type: CandidateChange['change']['change_type']
}

/**
 * A scripted stub proposer: generates one schema-valid candidate per call targeting a fixed
 * capability/metric, with a fresh id and a hypothesis that references the accumulated lessons. It
 * generates indefinitely; the loop's loop-until-dry / budget rule decides when to stop.
 */
export class StubProposer implements Proposer {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly spec: StubProposerSpec,
  ) {}

  propose(context: ProposerContext): CandidateChange {
    const candidateId = this.ids.next('cand')
    const candidate: CandidateChange = {
      candidate_id: candidateId,
      created_at: this.clock.now(),
      author: 'ai_proposer',
      hypothesis: {
        target_capability: this.spec.target_capability,
        target_metric_code: this.spec.target_metric_code,
        ...(this.spec.target_scenario_ids === undefined
          ? {}
          : { target_scenario_ids: [...this.spec.target_scenario_ids] }),
        expected_direction: this.spec.expected_direction,
        guards_to_watch: [...this.spec.guards_to_watch],
        rationale:
          `Targeting ${this.spec.target_capability} (iteration ${context.iteration}); ` +
          `${context.lessons.length} prior lesson(s) considered.`,
      },
      change: {
        change_type: this.spec.change_type,
        summary: `Stub change #${context.iteration} for ${this.spec.target_capability}.`,
        artifact_ref: `branch:${candidateId}`,
        reversible: true,
        capabilities_touched: [this.spec.target_capability],
        mid_engagement_safe: true,
      },
      risk_tier: 1,
      status: 'proposed',
    }
    return getSchemaRegistry().assertValid<CandidateChange>('candidate_change', candidate)
  }
}
