import { describe, expect, it } from 'vitest'

import {
  ALIGNED_VISION_MATCH,
  DEFAULT_VISION_MATCH,
  honestVisionConsultSession,
  honestVisionMatch,
} from '../../src/simulator/domain_facts'

/**
 * Phase-10 Step 3: the SHARED vision-alignment facts. `vision_match` is a DETERMINISTIC alignment (NOT a
 * judge) whose honest value is genome-dependent via the EXISTING tier-2 consult capability: a genome that
 * can CONSULT aligns the selection (`ALIGNED` 1.0) AND pays a `vision_consult` couple session; a tier-1
 * genome cannot consult → a `DEFAULT` (0.5) selection at no cost. That single tier-gated split is the
 * load-bearing limitation the firewall protects on BOTH axes — value (claim ALIGNED you can't earn) and
 * cost (shave/suppress the consult session). Pin it so a refactor can't flatten it (which would make the
 * gate vacuous OR false-positive every honest tier-2 run), exactly as category_facts/qa_facts do.
 */

describe('honestVisionMatch — the honest alignment of a vision-sensitive booked category', () => {
  it('a consulting (tier-2) genome ALIGNS the selection (1.0)', () => {
    expect(honestVisionMatch(true)).toBe(ALIGNED_VISION_MATCH)
    expect(ALIGNED_VISION_MATCH).toBe(1)
  })

  it('a tier-1 (cannot-consult) genome books a DEFAULT selection (0.5) — honest but unaligned', () => {
    // The load-bearing gap: a tier-1 candidate CLAIMING 1.0 here (quality up) without the consult cost
    // diverges from this trusted 0.5, which is what makes the value firewall load-bearing.
    expect(honestVisionMatch(false)).toBe(DEFAULT_VISION_MATCH)
    expect(DEFAULT_VISION_MATCH).toBe(0.5)
  })

  it('the consult cost is incurred IFF the genome can consult (the tier-2 surface)', () => {
    expect(honestVisionConsultSession(true)).toBe(true)
    expect(honestVisionConsultSession(false)).toBe(false)
  })

  it('ALIGNED is strictly above DEFAULT — so consulting is a real, non-vacuous quality lift', () => {
    expect(ALIGNED_VISION_MATCH).toBeGreaterThan(DEFAULT_VISION_MATCH)
  })
})
