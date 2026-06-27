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
 * SEEDING this rung is offline (compose seeds one demo guest); a planner-facing guest-management surface
 * (register/list/remove over the authenticated edge) is a deferred rung.
 *
 * related: tenant_scoped_repository.ts (the inherited isolation), guest_qa_responder.ts (the consumer of the
 * bound wedding's facts), messaging_port.ts (RecipientRef / the inbound from_ref).
 */

/** A guest bound to one wedding within one tenant. `tenant_id` is COMPARE-only (the repo never routes by it). */
export interface GuestBinding {
  readonly tenant_id: string
  /** The opaque sender handle — the lookup KEY (the inbound `from_ref`). Never a carrier-parsed value. */
  readonly recipient_ref: RecipientRef
  /** The single wedding this sender is bound to — the segmentation scope for every reply. */
  readonly wedding_id: string
  /** The guest's stable identifier within the wedding (for Q&A correlation; never a routing key). */
  readonly guest_id: string
}

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
   * CONTEXT (the repo vetoes a mismatch), so a binding can never be planted under another tenant.
   */
  register(context: TenantContext, input: RegisterGuestInput): GuestBinding {
    return this.#repo.put(context, { tenant_id: context.tenant_id, ...input })
  }

  /**
   * Resolve the wedding binding for an inbound sender ref, or `undefined` for an unregistered/foreign ref
   * (the byte-identical no-oracle path). Keyed on `from_ref` ALONE within the context's partition.
   */
  lookup(context: TenantContext, from_ref: RecipientRef): GuestBinding | undefined {
    return this.#repo.read(context, from_ref)
  }
}
