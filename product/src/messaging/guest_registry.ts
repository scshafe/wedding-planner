import { getSchemaRegistry, type Guest } from '@wedding-planner/shared'

import { ProductError } from '../product_error'
import { type TenantContext } from '../tenant/tenant_context'
import { TenantScopedRepository } from '../tenant/tenant_scoped_repository'
import type { TenantLivenessCheck } from '../tenant/tenant_store'
import type { RecipientRef } from './messaging_port'

/**
 * @canonical guest_registry -- the per-tenant binding of an opaque sender ref to ONE wedding (the guest
 * segmentation gate).
 *
 * A guest is NOT a session Principal (guests never log in). They are identified ONLY by an opaque, channel-
 * authenticated `recipient_ref` (the inbound `from_ref`) and bound to exactly ONE wedding here. This binding is
 * the guest analogue of the couple's structural ownership (wedding_authorizer.ts): it is the SOLE segmentation
 * gate — the inbound reply path answers ONLY from the wedding this registry returns, so a guest can never reach
 * another wedding's (or tenant's) data (the COMMS.MIS_SEGMENTATION analogue).
 *
 * Unforgeability + isolation are INHERITED, not re-implemented: the registry is a thin domain face over a
 * {@link TenantScopedRepository}, so every op runs `assertMintedContext` + liveness, the partition is keyed by
 * `context.tenant_id` ALONE, the key is the `recipient_ref` ALONE (NEVER a body-smuggled guest_id/wedding_id —
 * the inbound body's identity fields are ignored; the binding's wedding_id/guest_id come ONLY from the stored
 * record), an unknown ref returns the byte-identical `undefined` of a foreign one (no existence oracle), and a
 * cross-tenant write is vetoed. The backing map is `#`-private (no enumerate/serialize). `recipient_ref` is the
 * lookup key across all channels for that sender (opaque; no carrier parsing) — channel-scoped binding is a
 * possible later refinement, not needed while a sender maps to one wedding.
 *
 * Phase 21 adds the planner-facing management surface (`register`/`list`/`remove`) over the authenticated
 * edge: `register` rejects a duplicate ref and validates against the `guest` contract; `list`/`remove` are
 * tenant-scoped (isolation inherited); `remove` is idempotent. Compose still seeds one offline demo guest.
 *
 * related: tenant_scoped_repository.ts (the inherited isolation), guest_qa_responder.ts (the consumer of the
 * bound wedding's facts), messaging_port.ts (RecipientRef / the inbound from_ref).
 */

/**
 * A guest bound to one wedding within one tenant — the `guest` contract (single source of truth), the way
 * `Wedding`/`Tenant` are used. `tenant_id` is COMPARE-only (the repo never routes by it); `recipient_ref` is
 * the opaque sender handle (the inbound `from_ref`) and the lookup KEY. Registration validates against the
 * schema before persisting.
 */
export type GuestBinding = Guest

/** What a caller supplies to bind a sender (the tenant comes from the CONTEXT, never the input). */
export interface RegisterGuestInput {
  readonly recipient_ref: RecipientRef
  readonly wedding_id: string
  readonly guest_id: string
}

export class GuestRegistry {
  /** The isolation boundary, keyed (tenant_id, recipient_ref). `#`-private: never enumerates/serializes. */
  readonly #repo: TenantScopedRepository<GuestBinding>

  constructor(liveness: TenantLivenessCheck) {
    this.#repo = new TenantScopedRepository<GuestBinding>(liveness, (binding) => binding.recipient_ref)
  }

  /**
   * Bind a sender ref to a wedding within the context's tenant. The binding's tenant_id is taken from the
   * CONTEXT (the repo vetoes a mismatch), so a binding can never be planted under another tenant. REJECTS a
   * duplicate `recipient_ref` (PRODUCT.GUEST_ALREADY_REGISTERED) rather than silently rebinding it, then
   * VALIDATES the assembled binding against the `guest` contract before persisting (mirrors
   * WeddingRepository.create).
   */
  register(context: TenantContext, input: RegisterGuestInput): GuestBinding {
    if (this.#repo.read(context, input.recipient_ref) !== undefined) {
      throw new ProductError(
        'PRODUCT.GUEST_ALREADY_REGISTERED',
        `A guest is already registered for that recipient under this tenant; remove it first to rebind.`,
        { context: { tenant_id: context.tenant_id } },
      )
    }
    const binding: GuestBinding = { tenant_id: context.tenant_id, ...input }
    getSchemaRegistry().assertValid<Guest>('guest', binding)
    return this.#repo.put(context, binding)
  }

  /**
   * Resolve the wedding binding for an inbound sender ref, or `undefined` for an unregistered/foreign ref
   * (the byte-identical no-oracle path). Keyed on `from_ref` ALONE within the context's partition.
   */
  lookup(context: TenantContext, from_ref: RecipientRef): GuestBinding | undefined {
    return this.#repo.read(context, from_ref)
  }

  /** Every guest bound within the context's tenant (planner-facing list; only ever this tenant's partition). */
  list(context: TenantContext): readonly GuestBinding[] {
    return this.#repo.list(context)
  }

  /**
   * Remove a guest binding by `recipient_ref` within the context's tenant. IDEMPOTENT: an absent/foreign ref
   * is a no-op returning `false` (a trusted planner is never probed — no existence oracle). Returns whether a
   * binding existed.
   */
  remove(context: TenantContext, recipient_ref: RecipientRef): boolean {
    return this.#repo.delete(context, recipient_ref)
  }
}
