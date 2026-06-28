import { getSchemaRegistry, type Clock, type EscalationResolution, type IdGenerator } from '@wedding-planner/shared'

import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical escalation_resolution_log -- the per-tenant, wedding-scoped record of guest escalations that have
 * been HANDLED (Phase 27). The couple/planner counterpart to {@link EscalationLog}: where the escalation log
 * records the unanswerable question, this records that someone DEALT WITH it — `resolved` (typically the
 * missing fact was filled) or `dismissed` (not actionable: spam/irrelevant/duplicate). Both are terminal
 * "handled" states that move the escalation out of the Open inbox.
 *
 * THE ESCALATION STAYS IMMUTABLE (ADR 0026 F6, pinned). Handling is a SEPARATE append-only record keyed by
 * `escalation_id`, NEVER a mutation of the `guest_escalation` — the escalation remains the accurate historical
 * fact that the question WAS unanswerable at the time. {@link resolve} is READ-FIRST-PUT-IF-ABSENT →
 * FIRST-WRITER-WINS: resolving an already-handled escalation returns the EXISTING record (the first `status`
 * sticks; re-opening / changing a recorded status is a deferred future rung). This mirrors
 * inbound_receipt_log.ts / escalation_log.ts — the same self-contained-log pattern, keyed on a different field
 * (`escalation_id` here, `provider_message_ref` there).
 *
 * TRUSTED-STATE PROVENANCE. `tenant_id` comes from the CONTEXT (the repo vetoes a mismatch); `wedding_id` is
 * passed in by the handler, COPIED from the live escalation read in the SAME request (never a request body
 * field — so a body-smuggled wedding_id cannot widen a couple's reach); `resolved_by` is the minted
 * principal's role; `resolved_at` is stamped HERE from the injected {@link Clock} (never ambient/guest-
 * controlled) — unlike `received_at`, which the messaging PORT stamps, the resolution has no port, so it owns
 * its clock. The record is contract-validated before persisting.
 *
 * Isolation/unforgeability are INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness
 * on every op, partition keyed by `context.tenant_id` ALONE, `#`-private. The couple slice mirrors
 * escalation_log.ts: {@link listForWedding} filters the partition on `wedding_id` (oracle-free; `undefined` →
 * []), so a couple reads only their wedding's resolutions and never a sibling wedding's.
 *
 * related: escalation_log.ts (the escalation this resolves — and getByEscalationId, the scope lookup),
 * product_api.ts (the resolve mutation + the two-array read), ADR 0027.
 */

/** What the resolve handler supplies (tenant_id from the CONTEXT, resolution_id/resolved_at stamped here). */
export interface RecordResolutionInput {
  readonly escalation_id: string
  readonly wedding_id: string
  readonly status: EscalationResolution['status']
  readonly resolved_by: EscalationResolution['resolved_by']
}

export class EscalationResolutionLog {
  /** The isolation boundary, keyed (tenant_id, escalation_id). `#`-private: never enumerates/serializes. */
  readonly #repo: TenantScopedRepository<EscalationResolution>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {
    this.#repo = new TenantScopedRepository<EscalationResolution>(liveness, (resolution) => resolution.escalation_id)
  }

  /**
   * Record that an escalation has been handled within the context's tenant. IDEMPOTENT by `escalation_id`
   * (read-first-put-if-absent) → FIRST-WRITER-WINS: a second resolve of the same escalation returns the
   * EXISTING record (stable `resolution_id`, original `status`/`resolved_by`/`resolved_at`), so the recorded
   * handled state is immutable. The record's tenant_id is taken from the CONTEXT (the repo vetoes a mismatch),
   * resolved_at from the injected clock; validated against the `escalation_resolution` contract before persisting.
   */
  resolve(context: TenantContext, input: RecordResolutionInput): EscalationResolution {
    const existing = this.#repo.read(context, input.escalation_id)
    if (existing !== undefined) return existing
    const resolution: EscalationResolution = {
      resolution_id: this.ids.next('resolution'),
      tenant_id: context.tenant_id,
      escalation_id: input.escalation_id,
      wedding_id: input.wedding_id,
      status: input.status,
      resolved_by: input.resolved_by,
      resolved_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<EscalationResolution>('escalation_resolution', resolution)
    return this.#repo.put(context, resolution)
  }

  /** Every resolution within the context's tenant (planner-facing; only ever this tenant's partition). */
  list(context: TenantContext): readonly EscalationResolution[] {
    return this.#repo.list(context)
  }

  /**
   * Whether this escalation has ALREADY been handled within the context's tenant — a direct, O(1) read of
   * the (tenant_id, escalation_id)-keyed partition (the repo is keyed by escalation_id). Phase 28 uses it as
   * the reply gate: a reply-from-the-inbox sends/bills NOTHING for an already-resolved OR already-dismissed
   * escalation (so a `dismissed` escalation can never dispatch a billed guest message, and a double-submit is
   * a single send). Tenant-scoped by construction; a foreign/absent id returns `undefined` (the caller masks
   * absent and already-handled identically, so this is no existence oracle for a couple — it is reached ONLY
   * after the couple's own-wedding scope gate passes).
   */
  getByEscalationId(context: TenantContext, escalation_id: string): EscalationResolution | undefined {
    return this.#repo.read(context, escalation_id)
  }

  /**
   * The couple-facing slice: only the resolutions whose `wedding_id` matches, within the context's tenant. A
   * partition FILTER (mirrors escalation_log.ts / guest_registry.ts), NOT a probe. An `undefined` wedding_id (a
   * couple with no bound wedding) yields `[]` — the collapse lives HERE so the handler stays a pure scope-`kind`
   * branch.
   */
  listForWedding(context: TenantContext, wedding_id: string | undefined): readonly EscalationResolution[] {
    if (wedding_id === undefined) return []
    return this.#repo.list(context).filter((resolution) => resolution.wedding_id === wedding_id)
  }
}
