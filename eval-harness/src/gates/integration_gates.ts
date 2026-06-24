import type { EventEnvelope } from '@wedding-planner/shared'
import { EVENT_NAMES } from '@wedding-planner/telemetry'

import { GATE_CODES, type GateEvaluationContext, type GateResult, vetoGateResult } from './gate_types'

/**
 * The third-party-execution gates.
 *
 *   - INTEGRATION.SILENT_FAILURE — the product reported an action confirmed while the trusted record
 *     says it did not confirm (gate_checks.md). The product's claim is read for the "claimed
 *     confirmed" condition, but the authoritative outcome is always the trusted verified_status, so a
 *     product cannot make a failed action look successful.
 *   - INTEGRATION.DOUBLE_BOOK — two binding (confirmed) holds on the same resource/slot, from the
 *     trusted record.
 *
 * related: trusted_recorder.ts, adversarial_vendor_cancels_late.yaml.
 */

function readString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' ? (payload[key] as string) : null
}

export function checkIntegrationSilentFailure(ctx: GateEvaluationContext): GateResult {
  const evidence: string[] = []
  const resultEvents = ctx.productEvents.filter(
    (event: EventEnvelope) => event.event_name === EVENT_NAMES.integration_action_result,
  )
  for (const event of resultEvents) {
    const payload = event.payload as Record<string, unknown>
    if (readString(payload, 'claimed_status') !== 'confirmed') {
      continue // only "claimed confirmed" can be a silent failure
    }
    const actionId = readString(payload, 'action_id')
    const trusted = actionId === null ? undefined : ctx.recorder.integrationAction(actionId)
    if (trusted === undefined || trusted.verified_status !== 'confirmed') {
      evidence.push(
        `action:${String(actionId)} claimed=confirmed trusted=${trusted?.verified_status ?? 'no-record'}`,
      )
    }
  }
  return vetoGateResult(GATE_CODES.INTEGRATION_SILENT_FAILURE, evidence)
}

export function checkIntegrationDoubleBook(ctx: GateEvaluationContext): GateResult {
  const confirmedByTarget = new Map<string, string[]>()
  for (const action of ctx.recorder.allIntegrationActions()) {
    if (action.verified_status !== 'confirmed') {
      continue
    }
    const existing = confirmedByTarget.get(action.target_ref) ?? []
    existing.push(action.action_id)
    confirmedByTarget.set(action.target_ref, existing)
  }
  const evidence: string[] = []
  for (const [targetRef, actionIds] of confirmedByTarget) {
    if (actionIds.length >= 2) {
      evidence.push(`target:${targetRef} double-booked by ${actionIds.join(', ')}`)
    }
  }
  return vetoGateResult(GATE_CODES.INTEGRATION_DOUBLE_BOOK, evidence)
}
