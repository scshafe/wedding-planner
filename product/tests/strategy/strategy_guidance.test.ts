import { type StrategyGenome } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { describeStrategy, type StrategyGuidance, type StrategyKnobGuidance } from '@wedding-planner/product'

/** Find a knob by label, asserting it exists (keeps strict-mode index access out of the assertions). */
function knob(g: StrategyGuidance, label: string): StrategyKnobGuidance {
  const found = g.knobs.find((k) => k.label === label)
  expect(found, `knob '${label}' should exist`).toBeDefined()
  return found as StrategyKnobGuidance
}

/**
 * Step-1 coverage for the engine↔surface translation (Phase 17). `describeStrategy` is a PURE projection of
 * a champion genome into planner-facing guidance: it validates + RE-DERIVES the risk tier (never trusts a
 * declared one), maps each knob to human copy, and leaks none of the engine's lineage/surface internals.
 */

/** The published champion shape: the tier-1 optimum (cadence 3, spacing 1, batching 1). */
function tier1Genome(overrides: Partial<StrategyGenome['parameters']> = {}): StrategyGenome {
  return {
    genome_id: 'g_test',
    parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 1, reminder_batching: 1, ...overrides },
  }
}

describe('describeStrategy — the champion → planner-facing projection', () => {
  it('maps the three required flow knobs to human copy with levels and maxima', () => {
    const g = describeStrategy(tier1Genome())
    expect(g.headline).toMatch(/strategy/i)
    expect(g.knobs).toHaveLength(3)
    expect(knob(g, 'RSVP reminders')).toMatchObject({ level: 3, maxLevel: 3 })
    expect(knob(g, 'RSVP reminders').summary).toMatch(/up to 3 RSVP reminders/i)
    expect(knob(g, 'Reminder spacing')).toMatchObject({ level: 1, maxLevel: 3 })
    expect(knob(g, 'Reminder bundling')).toMatchObject({ level: 1, maxLevel: 3 })
    // batching level 1 -> digest size 2.
    expect(knob(g, 'Reminder bundling').summary).toMatch(/up to 2 per digest/i)
  })

  it('describes a zero-cadence champion as sending no extra reminders', () => {
    const g = describeStrategy(tier1Genome({ rsvp_reminder_cadence: 0, reminder_batching: 0 }))
    expect(knob(g, 'RSVP reminders').summary).toMatch(/no extra rsvp reminders/i)
    expect(knob(g, 'Reminder bundling').summary).toMatch(/sent on its own/i)
  })

  it('derives tier-1 (applied automatically) for the canonical genome — never a declared tier', () => {
    const g = describeStrategy(tier1Genome())
    expect(g.autonomy.tier).toBe(1)
    expect(g.autonomy.appliedAutomatically).toBe(true)
    expect(g.autonomy.label).toBe('Applied automatically')
    expect(g.autonomy.explanation).toMatch(/no human sign-off|applies it on its own|automatically/i)
  })

  it('derives tier-2 (requires human approval) when the optional autonomy_threshold is present', () => {
    const g = describeStrategy(tier1Genome({ autonomy_threshold: 2 }))
    expect(g.autonomy.tier).toBe(2)
    expect(g.autonomy.appliedAutomatically).toBe(false)
    expect(g.autonomy.label).toBe('Requires human approval')
    // A 4th knob describing the elevated autonomy is included only when the knob is carried.
    expect(g.knobs).toHaveLength(4)
    const autonomyKnob = g.knobs.find((k) => k.label === 'Acting without asking')
    expect(autonomyKnob).toMatchObject({ level: 2, maxLevel: 3 })
    expect(autonomyKnob?.summary).toMatch(/human must approve/i)
  })

  it('carries the honesty rail: platform-global, offline, NOT a per-wedding score', () => {
    const g = describeStrategy(tier1Genome())
    expect(g.disclaimer).toMatch(/every workspace/i)
    expect(g.disclaimer).toMatch(/not a score of any individual wedding/i)
  })

  it('leaks NO engine lineage/surface internals (no genome_id, surface name, hash, or error code)', () => {
    const blob = JSON.stringify(describeStrategy(tier1Genome({ autonomy_threshold: 3 })))
    expect(blob).not.toContain('g_test') // genome_id never appears
    expect(blob).not.toContain('genome:') // no content-hash artifact ref
    expect(blob).not.toMatch(/planning_flow_orchestration|commitment_autonomy/) // no surface names
    expect(blob).not.toMatch(/RISK\.|PRODUCT\.|CONTRACT\./) // no error codes
  })

  it('throws (fail-closed) on an invalid genome — an out-of-range knob', () => {
    const bad = { genome_id: 'g', parameters: { rsvp_reminder_cadence: 5, reminder_spacing: 1, reminder_batching: 1 } }
    expect(() => describeStrategy(bad as unknown as StrategyGenome)).toThrow()
  })

  it('throws (fail-closed) on a structurally invalid genome — missing parameters', () => {
    expect(() => describeStrategy({ genome_id: 'g' } as unknown as StrategyGenome)).toThrow()
  })

  it('is a pure function of the genome — same input, byte-identical output', () => {
    expect(JSON.stringify(describeStrategy(tier1Genome()))).toBe(JSON.stringify(describeStrategy(tier1Genome())))
  })
})
