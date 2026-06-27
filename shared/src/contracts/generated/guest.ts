/* eslint-disable */
/**
 * GENERATED from product/schemas/guest_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * A guest bound to exactly one wedding within one tenant (Phase 21) — the persisted record of the guest-registry segmentation gate (guest_registry.ts). A planner registers/lists/removes these over the authenticated edge; the inbound messaging webhook resolves a reply's wedding from the (tenant_id, recipient_ref) binding. Always accessed through a tenant-scoped repository: the lookup key is (tenant_id, recipient_ref), never recipient_ref alone, so refs need not be globally unique. A guest is NOT a session Principal (guests never log in) — identity is the opaque, channel-authenticated recipient_ref alone. See product/README.md and ADR 0021.
 */
export interface Guest {
/**
 * The owning tenant. In the tenant-scoped repository this field is ONLY ever compared to the context's tenant_id (to veto a cross-tenant write); it never selects the partition (the context does). A payload tenant_id different from the context is rejected (PRODUCT.CROSS_TENANT_WRITE).
 */
tenant_id: string
/**
 * The opaque sender handle — the lookup KEY within the tenant partition (the inbound from_ref). Vendor-agnostic: NO carrier semantics are parsed from it (no SID/E.164/segments), matching the messaging port's opaque-ref discipline.
 */
recipient_ref: string
/**
 * The single wedding this sender is bound to — the segmentation scope for every reply. Verified to exist within the tenant at registration time (a trusted planner owns the workspace; this is not an existence oracle).
 */
wedding_id: string
/**
 * The guest's stable identifier within the wedding (for Q&A correlation); never a routing key.
 */
guest_id: string
}
