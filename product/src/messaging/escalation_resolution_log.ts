import { getSchemaRegistry, type Clock, type EscalationResolution, type IdGenerator } from '@wedding-planner/shared'

import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'

/**
 * @canonical escalation_resolution_log -- the per-tenant, wedding-scoped APPEND-ONLY TRANSITION log of a guest
 * escalation's HANDLED status (Phase 27, generalized to a status MACHINE in Phase 36). The couple/planner
 * counterpart to {@link EscalationLog}: where the escalation log records the unanswerable question, this records
 * the sequence of transitions someone made on it — `resolved` (typically the missing fact was filled),
 * `dismissed` (not actionable: spam/irrelevant/duplicate), and (Phase 36) `reopened` (an explicit operator
 * action returning a handled escalation to the Open inbox so it can be replied to again).
 *
 * THE ESCALATION STAYS IMMUTABLE (ADR 0026 F6, pinned). Handling is a SEPARATE record keyed by
 * `${escalation_id}:${seq}`, NEVER a mutation of the `guest_escalation` — the escalation remains the accurate
 * historical fact that the question WAS unanswerable at the time. One escalation holds MANY transition rows,
 * one per SERVER-allocated `seq` (`max(existing seq)+1`, the {@link EscalationReplyLog} high-water pattern).
 *
 * EFFECTIVE STATUS IS A FOLD over the rows, NOT a single record (Phase 36 replaced the Phase-27 single-record,
 * first-writer-wins, TERMINAL model). {@link effectiveStatus} reads the HIGHEST-`seq` transition: no rows OR a
 * `reopened` max-`seq` ⇒ `'open'` (in the inbox); a `resolved`/`dismissed` max-`seq` ⇒ that handled status
 * (out of the Open inbox). {@link transition} enforces a DIRECTIONAL rule so the machine is well-formed and
 * every double-submit is idempotent WITHOUT a client seq or a nonce store (the read-then-append is ONE
 * synchronous critical section — the Phase-31 `settleBalance` argument):
 *   - `resolved`/`dismissed` append IFF the escalation is currently effective-`open` (so the FIRST handling of
 *     an open escalation sticks — the old first-writer-wins, preserved; a second resolve, or a resolve→dismiss,
 *     is a no-op);
 *   - `reopened` appends IFF the escalation is currently effective-HANDLED (a reopen of an already-open
 *     escalation is a no-op).
 * A no-op returns `undefined` (the desired state already holds); the handler treats append and no-op
 * identically (idempotent success). NOT terminal: an escalation can cycle resolved→reopened→resolved.
 *
 * RE-ENABLED REPLIES / KEYSTONE NOW CONDITIONAL (Phase 36). The Phase-28 reply gate ("a `dismissed` escalation
 * never dispatches a billed guest message") was TERMINAL; it is now CONDITIONAL on the EFFECTIVE status — a
 * `reopened` escalation is effective-`open` and again accepts billed reply turns. The no-bill property holds
 * for any CURRENTLY-handled (effective resolved/dismissed) escalation; reopening is the explicit, operator-
 * gated, CSRF-protected action that lifts it.
 *
 * TRUSTED-STATE PROVENANCE. `tenant_id` comes from the CONTEXT (the repo vetoes a mismatch); `wedding_id` is
 * passed in by the handler, COPIED from the live escalation read in the SAME request on EVERY transition
 * (never a request body field — so a body-smuggled wedding_id cannot widen a couple's reach, and every
 * transition row carries the couple-scope filter key); `resolved_by` is the minted principal's role;
 * `resolved_at` is stamped HERE from the injected {@link Clock}; `seq` is server-allocated here (never a body
 * field). The record is contract-validated before persisting.
 *
 * Isolation/unforgeability are INHERITED from {@link TenantScopedRepository}: minted-context brand + liveness
 * on every op, partition keyed by `context.tenant_id` ALONE, `#`-private. The couple slice mirrors
 * escalation_log.ts: {@link listForWedding} filters the partition on `wedding_id` (oracle-free; `undefined` →
 * []), so a couple reads only their wedding's transitions and never a sibling wedding's.
 *
 * related: escalation_log.ts (the escalation this records transitions for), escalation_reply_log.ts (the
 * sibling composite-keyed thread + the high-water seq pattern), product_api.ts (the resolve/reopen mutation +
 * the multi-array read), ADR 0027 / ADR 0036.
 */

/** What the transition handler supplies (tenant_id from the CONTEXT; resolution_id/seq/resolved_at stamped here). */
export interface RecordTransitionInput {
  readonly escalation_id: string
  readonly wedding_id: string
  /** The transition's target state: `resolved`/`dismissed` (from open) or `reopened` (from handled). */
  readonly status: EscalationResolution['status']
  readonly by: EscalationResolution['resolved_by']
}

/** An escalation's effective status, folded from its transition rows (`reopened` max-`seq` collapses to `open`). */
export type EffectiveEscalationStatus = 'open' | 'resolved' | 'dismissed'

/** The composite storage key: one escalation holds many transition rows, one per `seq`. */
function slotKey(escalation_id: string, seq: number): string {
  return `${escalation_id}:${seq}`
}

/** Fold a single escalation's transition rows to its effective status (the highest-`seq` row; `reopened` → open). */
function foldEffectiveStatus(rows: readonly EscalationResolution[]): EffectiveEscalationStatus {
  const max = maxBySeq(rows)
  if (max === undefined) return 'open'
  return max.status === 'reopened' ? 'open' : max.status
}

/** The highest-`seq` transition row, or `undefined` if there are none. */
function maxBySeq(rows: readonly EscalationResolution[]): EscalationResolution | undefined {
  let best: EscalationResolution | undefined
  for (const row of rows) if (best === undefined || row.seq > best.seq) best = row
  return best
}

export class EscalationResolutionLog {
  /** The isolation boundary, keyed (tenant_id, `${escalation_id}:${seq}`). `#`-private: never enumerates/serializes. */
  readonly #repo: TenantScopedRepository<EscalationResolution>

  constructor(
    liveness: TenantLivenessCheck,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {
    this.#repo = new TenantScopedRepository<EscalationResolution>(liveness, (row) => slotKey(row.escalation_id, row.seq))
  }

  /** All transition rows for one escalation within the context's tenant (the fold/allocation input). */
  #rowsFor(context: TenantContext, escalation_id: string): readonly EscalationResolution[] {
    return this.#repo.list(context).filter((row) => row.escalation_id === escalation_id)
  }

  /**
   * Record a status transition for an escalation within the context's tenant. DIRECTIONAL + IDEMPOTENT (see the
   * class header): `resolved`/`dismissed` append only from effective-`open`; `reopened` only from effective-
   * HANDLED. A transition that would not change direction is a no-op returning `undefined` (the desired state
   * already holds) — so every double-submit collapses to one row with no client seq / nonce. On append the new
   * row takes `seq = max(existing seq)+1`; tenant_id from the CONTEXT, resolved_at from the injected clock;
   * validated against the `escalation_resolution` contract before persisting. The read-then-append is ONE
   * synchronous critical section (no `await`), so a concurrent double-submit cannot double-append.
   */
  transition(context: TenantContext, input: RecordTransitionInput): EscalationResolution | undefined {
    const rows = this.#rowsFor(context, input.escalation_id)
    const effective = foldEffectiveStatus(rows)
    const allowed = input.status === 'reopened' ? effective !== 'open' : effective === 'open'
    if (!allowed) return undefined
    const seq = rows.reduce((max, row) => Math.max(max, row.seq), -1) + 1
    const row: EscalationResolution = {
      resolution_id: this.ids.next('resolution'),
      tenant_id: context.tenant_id,
      escalation_id: input.escalation_id,
      wedding_id: input.wedding_id,
      seq,
      status: input.status,
      resolved_by: input.by,
      resolved_at: this.clock.now(),
    }
    getSchemaRegistry().assertValid<EscalationResolution>('escalation_resolution', row)
    return this.#repo.put(context, row)
  }

  /**
   * The escalation's EFFECTIVE status within the context's tenant — the fold over its transition rows (the
   * highest-`seq` row; `reopened` ⇒ `'open'`; no rows ⇒ `'open'`). This REPLACED the Phase-27
   * `getByEscalationId !== undefined` handled-check at every reader (the inbound selector's open-test and the
   * reply gate's handled-test). Tenant-scoped by construction; reached only after the caller's own scope gate,
   * so no oracle (a foreign/absent id folds to `'open'`, indistinguishable from a never-handled one).
   */
  effectiveStatus(context: TenantContext, escalation_id: string): EffectiveEscalationStatus {
    return foldEffectiveStatus(this.#rowsFor(context, escalation_id))
  }

  /**
   * The escalation's CURRENT (highest-`seq`) transition row within the context's tenant, or `undefined` if it
   * has never been handled. The page reads it for the handled-row badge (`status`/`resolved_by`). Note a
   * `reopened` max-`seq` row makes the escalation effective-`open`, so it renders in the OPEN column and this
   * row's `reopened` status is never shown as a handled badge.
   */
  effectiveTransition(context: TenantContext, escalation_id: string): EscalationResolution | undefined {
    return maxBySeq(this.#rowsFor(context, escalation_id))
  }

  /** Every transition row within the context's tenant (planner-facing; only ever this tenant's partition). */
  list(context: TenantContext): readonly EscalationResolution[] {
    return this.#repo.list(context)
  }

  /**
   * The couple-facing slice: only the transition rows whose `wedding_id` matches, within the context's tenant. A
   * partition FILTER (mirrors escalation_log.ts / escalation_reply_log.ts), NOT a probe. An `undefined`
   * wedding_id (a couple with no bound wedding) yields `[]` — the collapse lives HERE so the handler stays a
   * pure scope-`kind` branch.
   */
  listForWedding(context: TenantContext, wedding_id: string | undefined): readonly EscalationResolution[] {
    if (wedding_id === undefined) return []
    return this.#repo.list(context).filter((row) => row.wedding_id === wedding_id)
  }
}
