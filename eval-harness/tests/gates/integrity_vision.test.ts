import {
  checkIntegritySelfReportDivergence,
  detectSelfReportDivergence,
  type SelfReportDivergence,
  TrustedRecorder,
} from '@wedding-planner/eval-harness'
import { type EventEnvelope, ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { buildEvent, EVENT_NAMES } from '@wedding-planner/telemetry'
import { describe, expect, it } from 'vitest'

/**
 * Phase-10 Step 5: the integrity gate's 8th reconciled effect kind `vision_alignment`. It backs the claimed
 * `vision_match_rate` (the only `planning_value.quality` rubric backed offline), keyed on `category_id`,
 * with TWO reconciliation surfaces mirroring `category_booking`: the join key (forged / duplicate /
 * suppressed — the denominator defense) and `vision_match_score` (field_mismatch — the numerator defense).
 * It is ORTHOGONAL to `category_booking` (a separate event + effect kind, independent denominator). These
 * tests pin every arm plus that an honest stream is clean and the value/cost surfaces don't interfere. The
 * COST side (the `vision_consult` couple session) is reconciled by the couple-session gate, not here.
 */

function makeBuilder(): (payload: Record<string, unknown>) => EventEnvelope {
  const clock = new ManualClock('2027-02-02T15:00:00.000Z')
  const ids = new SequentialIdGenerator('seedVisIntegrity')
  return (payload) =>
    buildEvent(clock, ids, {
      event_name: EVENT_NAMES.category_vision_aligned,
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'booking',
      capability: 'budget_management',
      actor: 'ai',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0' },
    })
}

function visDivs(events: readonly EventEnvelope[], recorder: TrustedRecorder): SelfReportDivergence[] {
  return detectSelfReportDivergence(events, recorder).filter((d) => d.effect_kind === 'vision_alignment')
}

/**
 * A recorder for a TIER-1 genome: it books two vision-sensitive categories with the honest DEFAULT (0.5)
 * selection (it cannot consult the couple to align them).
 */
function tier1Recorder(): TrustedRecorder {
  const recorder = new TrustedRecorder()
  recorder.recordVisionAlignment({ category_id: 'cat_decor', vision_match_score: 0.5 })
  recorder.recordVisionAlignment({ category_id: 'cat_florals', vision_match_score: 0.5 })
  return recorder
}

describe('integrity — vision reconciliation (the claimed vision_match_rate)', () => {
  it('passes when the claimed alignments match the trusted record', () => {
    const emit = makeBuilder()
    const events = [
      emit({ category_id: 'cat_decor', vision_match_score: 0.5 }),
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
    ]
    expect(checkIntegritySelfReportDivergence(events, tier1Recorder()).passed).toBe(true)
  })

  it('VETOES the headline forge: a tier-1 candidate CLAIMS aligned 1.0 (trusted says 0.5)', () => {
    const emit = makeBuilder()
    const events = [
      emit({ category_id: 'cat_decor', vision_match_score: 1 }), // FORGE: claimed-aligned, cannot consult
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
    ]
    const divs = visDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('field_mismatch')
    expect(divs[0]?.field).toBe('vision_match_score')
    expect(divs[0]?.effect_id).toBe('cat_decor')
    expect(checkIntegritySelfReportDivergence(events, tier1Recorder()).passed).toBe(false)
  })

  it('VETOES a forged (phantom) vision alignment with no trusted record', () => {
    const emit = makeBuilder()
    const events = [
      emit({ category_id: 'cat_decor', vision_match_score: 0.5 }),
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
      emit({ category_id: 'cat_phantom', vision_match_score: 1 }), // phantom
    ]
    const divs = visDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.effect_id).toBe('cat_phantom')
  })

  it('VETOES a DUPLICATE claim for the same category_id as ONE forged_effect (no spurious mismatch)', () => {
    const emit = makeBuilder()
    const dup = { category_id: 'cat_decor', vision_match_score: 0.5 }
    const events = [
      emit(dup),
      emit(dup), // re-emit to dilute a low score in the mean
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
    ]
    const divs = visDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.effect_id).toBe('cat_decor')
  })

  it('VETOES an absent vision_match_score against a trusted value (skipWhenClaimAbsent:false)', () => {
    const emit = makeBuilder()
    const events = [
      emit({ category_id: 'cat_decor' }), // no vision_match_score
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
    ]
    const divs = visDivs(events, tier1Recorder())
    expect(divs.some((d) => d.kind === 'field_mismatch' && d.field === 'vision_match_score')).toBe(true)
  })

  it('detects a suppressed vision alignment (trusted record, no claim) — dropping a low score to lift the mean', () => {
    const emit = makeBuilder()
    // Claim only one; drop the other to shrink the denominator / drop a 0.5.
    const events = [emit({ category_id: 'cat_decor', vision_match_score: 0.5 })]
    const divs = visDivs(events, tier1Recorder())
    expect(divs).toHaveLength(1)
    expect(divs[0]?.kind).toBe('suppressed_effect')
    expect(divs[0]?.effect_id).toBe('cat_florals')
  })

  it('flags a missing join key (no category_id) as forged', () => {
    const emit = makeBuilder()
    const events = [emit({ vision_match_score: 1 })]
    const divs = visDivs(events, tier1Recorder())
    expect(divs[0]?.kind).toBe('forged_effect')
    expect(divs[0]?.field).toBe('category_id')
  })

  it('is ORTHOGONAL to category_booking — a vision forge produces ONLY a vision_alignment divergence', () => {
    // The same category carries both a category.booked and a category.vision.aligned; a forge on the
    // vision axis must not masquerade as (or be masked by) a completeness divergence, and vice versa.
    const recorder = tier1Recorder()
    recorder.recordCategoryBooking({ category_id: 'cat_decor', category: 'decor', booking_status: 'booked' })
    const clock = new ManualClock('2027-02-03T15:00:00.000Z')
    const ids = new SequentialIdGenerator('seedVisOrtho')
    const bookedClaim = buildEvent(clock, ids, {
      event_name: EVENT_NAMES.category_booked,
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'booking',
      capability: 'budget_management',
      actor: 'ai',
      source: 'eval',
      payload: { category_id: 'cat_decor', category: 'decor', booking_status: 'booked' }, // HONEST completeness
      meta: { schema_version: '1.0.0' },
    })
    const emit = makeBuilder()
    const events = [
      bookedClaim,
      emit({ category_id: 'cat_decor', vision_match_score: 1 }), // vision FORGE (trusted 0.5)
      emit({ category_id: 'cat_florals', vision_match_score: 0.5 }),
    ]
    const all = detectSelfReportDivergence(events, recorder)
    expect(all.filter((d) => d.effect_kind === 'vision_alignment')).toHaveLength(1)
    expect(all.filter((d) => d.effect_kind === 'category_booking')).toHaveLength(0)
  })
})
