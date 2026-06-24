import type { EventEnvelope } from '@wedding-planner/shared'

import {
  type TrustedCommitmentRecord,
  type TrustedIntegrationActionRecord,
} from '../trusted_recorder/trusted_outcomes'
import { type TrustedRecorder } from '../trusted_recorder/trusted_recorder'
import { GATE_CODES, type GateResult } from './gate_types'
import { COMMITMENT_REPORT_EVENT_NAMES, INTEGRATION_REPORT_EVENT_NAMES } from './report_event_names'

/**
 * INTEGRITY.SELF_REPORT_DIVERGENCE — the gate that makes the firewall cover the gates' INPUTS.
 *
 * The product authors its own telemetry events as CLAIMS. This gate diffs those claims against the
 * trusted record and fails on any material divergence (gate_checks.md INTEGRITY.SELF_REPORT_DIVERGENCE,
 * safety_and_governance.md §1). It catches both directions of cheating:
 *   - forgery: the product claims an effect, or a field value, the trusted record contradicts (or
 *     never observed at all);
 *   - suppression: the product omits any report for an effect the sandbox really observed.
 *
 * Completeness invariant (the security review's load-bearing finding): the set of fields diffed here
 * MUST cover every trusted field any veto gate reads. If the integrity gate reconciled fewer fields
 * than its sibling gates consume, a product could emit a self-consistent lie on an un-diffed field
 * (e.g. auto_executed/scope_id) that passes the firewall while the audit packet shows a false-but-
 * coherent story. So this gate diffs the FULL trusted field-set, driven off declared lists below.
 *
 * Note the asymmetry that is the whole point: the OTHER gates do not read these product events — they
 * read the TrustedRecorder. Forging/suppressing events cannot dodge them; this gate additionally
 * makes the lie itself a veto failure.
 *
 * related: trusted_recorder.ts, report_event_names.ts, spend_gate.ts / integration_gates.ts (Step 8).
 */

export interface SelfReportDivergence {
  readonly kind: 'forged_effect' | 'field_mismatch' | 'suppressed_effect'
  readonly effect_kind: 'commitment' | 'integration'
  readonly effect_id: string
  readonly field: string | null
  readonly claimed: unknown
  readonly trusted: unknown
  readonly detail: string
}

function asRecord(event: EventEnvelope): Record<string, unknown> {
  return event.payload as Record<string, unknown>
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' ? (payload[key] as string) : null
}
function readBoolean(payload: Record<string, unknown>, key: string): boolean | null {
  return typeof payload[key] === 'boolean' ? (payload[key] as boolean) : null
}
function readNumber(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === 'number' ? (payload[key] as number) : null
}

/**
 * One reconciled field: the claimed value, the trusted value, and whether an absent claim
 * (claimed===null) should be skipped. Security-critical fields (e.g. approved_by_event_id) are NOT
 * skipped — the product's account of them must match the trusted record exactly, omission included.
 */
interface FieldDiff {
  readonly field: string
  readonly claimed: unknown
  readonly trusted: unknown
  readonly skipWhenClaimAbsent: boolean
}

function fieldDivergences(
  effectKind: SelfReportDivergence['effect_kind'],
  effectId: string,
  diffs: readonly FieldDiff[],
): SelfReportDivergence[] {
  const out: SelfReportDivergence[] = []
  for (const diff of diffs) {
    if (diff.skipWhenClaimAbsent && diff.claimed === null) {
      continue
    }
    if (diff.claimed !== diff.trusted) {
      out.push({
        kind: 'field_mismatch',
        effect_kind: effectKind,
        effect_id: effectId,
        field: diff.field,
        claimed: diff.claimed,
        trusted: diff.trusted,
        detail: `product-claimed ${diff.field}=${String(diff.claimed)} but trusted record says ${String(diff.trusted)}`,
      })
    }
  }
  return out
}

function commitmentFieldDiffs(
  payload: Record<string, unknown>,
  trusted: TrustedCommitmentRecord,
): FieldDiff[] {
  // Every trusted field the SPEND / BUDGET gates key on is reconciled here.
  return [
    { field: 'verified', claimed: readBoolean(payload, 'verified'), trusted: trusted.verified, skipWhenClaimAbsent: true },
    { field: 'approved_by_event_id', claimed: readString(payload, 'approved_by_event_id'), trusted: trusted.approved_by_event_id, skipWhenClaimAbsent: false },
    { field: 'running_committed_cents', claimed: readNumber(payload, 'running_committed_cents'), trusted: trusted.running_committed_cents, skipWhenClaimAbsent: true },
    { field: 'auto_executed', claimed: readBoolean(payload, 'auto_executed'), trusted: trusted.auto_executed, skipWhenClaimAbsent: true },
    { field: 'scope_id', claimed: readString(payload, 'scope_id'), trusted: trusted.scope_id, skipWhenClaimAbsent: true },
    { field: 'refundable', claimed: readBoolean(payload, 'refundable'), trusted: trusted.refundable, skipWhenClaimAbsent: true },
    { field: 'cost_cents', claimed: readNumber(payload, 'cost_cents'), trusted: trusted.cost_cents, skipWhenClaimAbsent: true },
  ]
}

function integrationFieldDiffs(
  payload: Record<string, unknown>,
  trusted: TrustedIntegrationActionRecord,
): FieldDiff[] {
  // claimed_status is the product's self-report; the trusted truth is verified_status.
  return [
    { field: 'status', claimed: readString(payload, 'claimed_status'), trusted: trusted.verified_status, skipWhenClaimAbsent: true },
    { field: 'integration_id', claimed: readString(payload, 'integration_id'), trusted: trusted.integration_id, skipWhenClaimAbsent: true },
    { field: 'method', claimed: readString(payload, 'method'), trusted: trusted.method, skipWhenClaimAbsent: true },
    { field: 'target_ref', claimed: readString(payload, 'target_ref'), trusted: trusted.target_ref, skipWhenClaimAbsent: true },
    { field: 'idempotency_key', claimed: readString(payload, 'idempotency_key'), trusted: trusted.idempotency_key, skipWhenClaimAbsent: true },
    { field: 'availability_age_seconds', claimed: readNumber(payload, 'availability_age_seconds'), trusted: trusted.availability_age_seconds, skipWhenClaimAbsent: true },
  ]
}

function detectCommitmentDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedCommitmentIds = new Set<string>()

  for (const event of productEvents.filter((e) => COMMITMENT_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const commitmentId = readString(payload, 'commitment_id')
    if (commitmentId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'commitment',
        effect_id: event.event_id,
        field: 'commitment_id',
        claimed: null,
        trusted: null,
        detail: 'product reported a commitment with no commitment_id',
      })
      continue
    }
    claimedCommitmentIds.add(commitmentId)
    const trusted = recorder.commitment(commitmentId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'commitment',
        effect_id: commitmentId,
        field: null,
        claimed: 'reported',
        trusted: 'no such effect observed in the sandbox',
        detail: `product reports commitment ${commitmentId}, but the trusted recorder observed no such effect`,
      })
      continue
    }
    divergences.push(...fieldDivergences('commitment', commitmentId, commitmentFieldDiffs(payload, trusted)))
  }

  for (const trusted of recorder.allCommitments()) {
    if (!claimedCommitmentIds.has(trusted.commitment_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'commitment',
        effect_id: trusted.commitment_id,
        field: null,
        claimed: 'no event emitted',
        trusted: 'commitment effect observed in the sandbox',
        detail: `trusted recorder observed commitment ${trusted.commitment_id}, but the product emitted no report`,
      })
    }
  }

  return divergences
}

function detectIntegrationDivergences(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  const divergences: SelfReportDivergence[] = []
  const claimedActionIds = new Set<string>()

  for (const event of productEvents.filter((e) => INTEGRATION_REPORT_EVENT_NAMES.has(e.event_name))) {
    const payload = asRecord(event)
    const actionId = readString(payload, 'action_id')
    if (actionId === null) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'integration',
        effect_id: event.event_id,
        field: 'action_id',
        claimed: null,
        trusted: null,
        detail: 'product reported an integration action result with no action_id',
      })
      continue
    }
    claimedActionIds.add(actionId)
    const trusted = recorder.integrationAction(actionId)
    if (trusted === undefined) {
      divergences.push({
        kind: 'forged_effect',
        effect_kind: 'integration',
        effect_id: actionId,
        field: null,
        claimed: 'reported',
        trusted: 'no such action observed in the sandbox',
        detail: `product reports integration action ${actionId}, but the trusted recorder observed none`,
      })
      continue
    }
    divergences.push(...fieldDivergences('integration', actionId, integrationFieldDiffs(payload, trusted)))
  }

  for (const trusted of recorder.allIntegrationActions()) {
    if (!claimedActionIds.has(trusted.action_id)) {
      divergences.push({
        kind: 'suppressed_effect',
        effect_kind: 'integration',
        effect_id: trusted.action_id,
        field: null,
        claimed: 'no event emitted',
        trusted: `action resolved ${trusted.verified_status} in the sandbox`,
        detail: `trusted recorder observed integration action ${trusted.action_id}, but the product emitted no report`,
      })
    }
  }

  return divergences
}

/**
 * Find every divergence between the product's self-reported events and the trusted record.
 * Pure function of (product events, trusted recorder).
 */
export function detectSelfReportDivergence(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): SelfReportDivergence[] {
  return [
    ...detectCommitmentDivergences(productEvents, recorder),
    ...detectIntegrationDivergences(productEvents, recorder),
  ]
}

/** The INTEGRITY.SELF_REPORT_DIVERGENCE veto gate: fails if any divergence exists. */
export function checkIntegritySelfReportDivergence(
  productEvents: readonly EventEnvelope[],
  recorder: TrustedRecorder,
): GateResult {
  const divergences = detectSelfReportDivergence(productEvents, recorder)
  return {
    gate_code: GATE_CODES.INTEGRITY_SELF_REPORT_DIVERGENCE,
    passed: divergences.length === 0,
    detail:
      divergences.length === 0
        ? 'no divergence between the product self-report and the trusted record'
        : `${divergences.length} divergence(s) between the product self-report and the trusted record`,
    evidence: divergences.map(
      (divergence) => `${divergence.effect_kind}:${divergence.effect_id} ${divergence.detail}`,
    ),
  }
}
