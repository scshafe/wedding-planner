import { describe, expect, it } from 'vitest'

import {
  type CandidateChange,
  type CommitmentPayload,
  type EventEnvelope,
  SchemaRegistry,
} from '@wedding-planner/shared'

/**
 * Round-trip: a value the TypeScript types accept must also pass ajv validation against the same
 * schema. This is the guarantee that the generated types and the runtime contracts cannot drift —
 * if json-schema-to-typescript and ajv disagreed, one of these constructions would fail to compile
 * or fail to validate.
 */
describe('contract types <-> runtime schema round-trip', () => {
  const registry = new SchemaRegistry()

  it('a typed EventEnvelope (with a commitment payload) validates against event_envelope', () => {
    const payload: CommitmentPayload = {
      commitment_id: 'cmt_1',
      vendor_category: 'venue',
      cost_cents: 1_500_000,
      refundable: true,
      status: 'executed',
      scope_id: null,
      approved_by_event_id: 'evt_approval_1',
      running_committed_cents: 1_500_000,
      verified: true,
    }
    const envelope: EventEnvelope = {
      event_id: 'evt_1',
      event_name: 'commitment.executed',
      occurred_at: '2027-01-02T15:00:00Z',
      trace_id: 'trace_1',
      wedding_id: 'wed_1',
      phase: 'booking',
      capability: 'budget_management',
      actor: 'ai',
      source: 'eval',
      payload,
      meta: { schema_version: '1.0.0', harness_version: 'h1', product_version: 'p1', seed: 's1' },
    }

    const result = registry.validate('event_envelope', envelope)
    expect(result.valid, JSON.stringify(result.errors)).toBe(true)
  })

  it('a typed CandidateChange validates against candidate_change', () => {
    const candidate: CandidateChange = {
      candidate_id: 'cand_1',
      created_at: '2027-01-02T15:00:00Z',
      author: 'ai_proposer',
      hypothesis: {
        target_capability: 'rsvp',
        target_metric_code: 'rsvp_resolution_rate',
        target_scenario_ids: ['golden_standard_end_to_end'],
        expected_direction: 'increase',
        expected_magnitude: 0.05,
        guards_to_watch: ['qa_accuracy_rate'],
        rationale: 'Earlier, gentler reminder cadence should lift resolution without nagging.',
      },
      change: {
        change_type: 'flow',
        summary: 'Add a second RSVP reminder at the two-week mark.',
        artifact_ref: 'branch:rsvp/second-reminder@abc123',
        reversible: true,
        capabilities_touched: ['rsvp'],
        mid_engagement_safe: true,
      },
      risk_tier: 1,
      depends_on: [],
      status: 'proposed',
    }

    const result = registry.validate('candidate_change', candidate)
    expect(result.valid, JSON.stringify(result.errors)).toBe(true)
  })

  it('the schema still rejects a structurally-broken value (types are not the only guard)', () => {
    // Force an invalid value past the type system to prove ajv is doing real work at runtime.
    const brokenEnvelope = {
      event_id: 'evt_2',
      // event_name missing -> required violation
      occurred_at: '2027-01-02T15:00:00Z',
      trace_id: 'trace_2',
      wedding_id: 'wed_1',
      phase: 'booking',
      capability: 'budget_management',
      actor: 'ai',
      source: 'eval',
      payload: {},
      meta: { schema_version: '1.0.0' },
    } as unknown as EventEnvelope

    const result = registry.validate('event_envelope', brokenEnvelope)
    expect(result.valid).toBe(false)
  })
})
