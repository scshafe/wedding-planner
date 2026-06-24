import { type CouplePersona, getSchemaRegistry } from '@wedding-planner/shared'

/**
 * Build a schema-valid synthetic couple persona for gate unit tests, with the gate-relevant slices
 * (budget, hard_constraints, spend_autonomy) overridable. Validated against the couple_persona
 * contract so a malformed fixture fails loudly rather than silently exercising the gate with bad data.
 */
export interface CouplePersonaOverrides {
  readonly persona_id?: string
  readonly budget?: CouplePersona['budget']
  readonly hard_constraints?: CouplePersona['hard_constraints']
  readonly spend_autonomy?: CouplePersona['spend_autonomy']
}

export function buildCouplePersona(overrides: CouplePersonaOverrides = {}): CouplePersona {
  const persona: CouplePersona = {
    persona_id: overrides.persona_id ?? 'couple_test_synthetic',
    description: 'Synthetic couple for gate unit tests.',
    wedding_date: { target_date: '2027-06-01', flexibility: 'same_month' },
    guest_count_target: { count: 100, flexibility: 'soft' },
    location: { region: 'Austin, Texas, USA', willing_travel_radius_km: 50 },
    budget: overrides.budget ?? {
      total_budget_cents: 4_000_000,
      hard_ceiling: false,
      flexibility_pct: 5,
      category_priorities: [],
    },
    vision: {
      aesthetic_keywords: ['garden'],
      formality_level: 'semi_formal',
      must_haves: [],
      must_not_haves: [],
    },
    hard_constraints: overrides.hard_constraints ?? [],
    decision_style: 'collaborative',
    spend_autonomy: overrides.spend_autonomy ?? {
      default_mode: 'propose_confirm',
      opted_in_scopes: [],
    },
    effort_budget: { max_active_minutes_per_week: 90, tolerance: 'medium' },
    simulation_behavior: { responsiveness: 'prompt', pickiness: 'particular', clarity: 'clear' },
  }
  return getSchemaRegistry().assertValid<CouplePersona>('couple_persona', persona)
}
